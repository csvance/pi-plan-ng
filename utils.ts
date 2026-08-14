/**
 * Plan mode helpers: read-only bash validation, config loading, profile
 * allowlist expansion, and plan-file write-path checks.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

/* ------------------------------------------------------------------ */
/* Safe bash                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read-only commands allowed in plan mode (bare names only; no paths).
 * Anything that can write files, execute other commands, or touch the
 * network is deliberately excluded (`awk`, `sed`, `xargs`, `env`, `curl`,
 * `wget`, `ssh`, `sudo`, `git` write subcommands, ...).
 */
const SAFE_COMMANDS = new Set([
  // files & directories
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "file", "stat",
  "du", "df", "realpath", "readlink", "basename", "dirname", "nl", "fold", "tac",
  "sort", "uniq", "cut", "tr", "comm", "join", "paste", "column", "od", "hexdump",
  "xxd", "strings", "sha256sum", "md5sum", "jq", "yq", "bat", "less", "more",
  "diff", "cmp",
  // navigation (only useful chained via &&; does not persist across calls)
  "cd",
  // process & environment info (read-only)
  "pwd", "which", "whoami", "echo", "printf", "printenv", "date", "uptime", "uname",
  "id", "hostname", "ps", "type",
]);

/** Read-only git subcommands. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "ls-files", "rev-parse", "shortlog", "blame",
  "whatchanged", "describe", "check-ignore", "check-attr", "count-objects",
  "symbolic-ref", "name-rev", "help", "version", "ls-tree", "grep",
]);

/** `find` flags that mutate the filesystem or execute commands. */
const FIND_DANGEROUS = /^-?(exec|execdir|ok|okdir|delete|fprint|fprint0|fls|fprintf)/;

/**
 * Write/exec-capable flags on otherwise allowlisted commands (like FIND_DANGEROUS).
 * Each key is a command head; any argument word (dequoted — see checkSafeSegment)
 * matching one of its regexes makes the segment unsafe.
 */
const COMMAND_FLAG_DENY: Record<string, RegExp[]> = {
  // GNU sort: -o / -o= / -oFILE and the long alias --output / --output= all write;
  // --compress-program PROG spawns PROG (popen) on sorted chunks — code execution.
  sort: [/^(-o|--output)/, /^--compress-program($|=)/],
  yq: [/^(-i|--inplace)($|=)/],
  // git --output=FILE writes; --output-indicator-* (diff formatting) stays allowed.
  git: [/^--output($|=)/],
  // rg --pre <cmd> pipes every searched file through cmd — with the plan file as
  // the searched content this is arbitrary code execution; --pager <cmd> spawns a
  // pager command when stdout is a tty (defense-in-depth; inert headless today).
  rg: [/^--pre($|=)/, /^--pager($|=)/],
  // tree -o FILE sends the listing to FILE instead of stdout (junk/overwrite
  // primitive: `tree -o ~/.bashrc .` clobbers an arbitrary path).
  tree: [/^-o/, /^--output-file($|=)/],
  // tty-dependent write/exec flags (inert through the non-interactive bash
  // tool today, but live if a profile ever grants a pty): less -o/-O copy
  // input to a log file; bat --pager runs a pager command. Defense-in-depth.
  less: [/^-o/, /^-O/, /^--log-file($|=)/, /^--LOG-FILE($|=)/],
  bat: [/^--pager($|=)/],
};

/**
 * git subcommand-specific exec/write flags (like COMMAND_FLAG_DENY but keyed
 * by subcommand — e.g. `git diff -O<orderfile>` is read-only while
 * `git grep -O<pager>` executes a command). Checked post-dequote, same as
 * COMMAND_FLAG_DENY.
 */
const GIT_SUBCOMMAND_FLAG_DENY: Record<string, RegExp[]> = {
  // git grep -O / --open-files-in-pager run <pager> on every matching file;
  // with a payload in the plan file (the one file the agent can write) this is
  // arbitrary code execution. The pager can carry a full command via quoting
  // (`-O'touch /tmp/pwn'`), so the whole `-O`-prefixed word is denied.
  grep: [/^-O/, /^--open-files-in-pager($|=)/],
};

/**
 * Human wording for each deny regex in COMMAND_FLAG_DENY /
 * GIT_SUBCOMMAND_FLAG_DENY, same keys and same array order as those
 * tables. Kept adjacent and in sync: when a deny regex changes, its
 * wording here (and the mirror text in describePlanModeBashRules) must
 * change with it.
 */
const COMMAND_FLAG_DENY_REASONS: Record<string, string[]> = {
  sort: ["writes output to a file", "executes a program on the data"],
  yq: ["writes the file in place"],
  git: ["writes output to a file"],
  rg: ["executes a command on every searched file", "spawns a pager command"],
  tree: ["writes the listing to a file"],
  less: ["writes input to a log file", "writes input to a log file", "writes input to a log file", "writes input to a log file"],
  bat: ["spawns a pager command"],
};

const GIT_SUBCOMMAND_FLAG_DENY_REASONS: Record<string, string[]> = {
  grep: ["executes a pager command on matching files", "executes a pager command on matching files"],
};

/** Live comma-joined allowed git subcommands, reused by git reasons. */
const GIT_SUBCOMMANDS_TEXT = [...SAFE_GIT_SUBCOMMANDS].sort().join(", ");

/**
 * First dequoted token matching any deny regex (tokens left-to-right,
 * regexes in table order — deterministic), plus the human wording for
 * the matching regex. Returns null when nothing matches.
 */
function firstFlagHit(
  tokens: string[],
  regexes: ReadonlyArray<RegExp>,
  wording: ReadonlyArray<string> | undefined,
): { token: string; reason: string } | null {
  for (const w of tokens) {
    for (let i = 0; i < regexes.length; i++) {
      if (regexes[i].test(w)) {
        return { token: w, reason: wording?.[i] ?? "is a write/exec-capable flag" };
      }
    }
  }
  return null;
}

/**
 * True when a `git symbolic-ref` invocation is the read-only query form.
 * `git symbolic-ref <name> <ref>` writes the symbolic ref (repo-state
 * mutation, e.g. pointing HEAD at a crafted ref) and `--delete` removes it,
 * so only the query form is safe: at most one non-flag argument (the ref
 * name), with `-m/--reason <reason>` consuming its value.
 * `tokens` is the full dequoted segment: [git, symbolic-ref, args...].
 */
function isSafeSymbolicRef(tokens: string[]): boolean {
  let positionals = 0;
  for (let i = 2; i < tokens.length; i++) {
    const w = tokens[i];
    if (w === "-m" || w === "--reason") {
      i++; // consume the reason value
      continue;
    }
    if (w === "--delete") return false; // deletes the ref — a write
    if (w.startsWith("-")) continue; // -q/--quiet, --short, -mreason, ...
    positionals++;
  }
  return positionals < 2;
}

/** git arguments that look like network remotes (URL or scp-style). */
const GIT_REMOTE = /^([a-z][a-z0-9+.-]*:\/\/|[^@\s]+@[^:\s]+:)/;

/** Control characters never allowed anywhere in a plan-mode command. */
const FORBIDDEN_ALWAYS = /[\r\n\x00]/;

/** Human meaning of each unquoted metacharacter rejected by checkComposition. */
const METACHAR_MEANING: Record<string, string> = {
  ";": "is a command separator",
  "$": "expands variables or commands",
  "`": "runs a command substitution",
  "<": "redirects input",
  ">": "redirects output",
  "(": "starts a subshell",
  ")": "closes a subshell",
};

/**
 * Scan a command and split it on *unquoted* `&&` operators and `|`
 * pipelines, rejecting metacharacters where bash would interpret them:
 * unquoted `;` `$` backtick `<` `>` `(` `)`; `$` and backticks also
 * inside double quotes (bash still expands them there); a lone `&`
 * (backgrounding, `|&`, `&>`); `||`; and unterminated quotes.
 * Single-quoted text is fully literal (backslashes included).
 *
 * Returns `{ segments }` on success — with `commentAt` set when an
 * unquoted word-start `#` truncated the command (bash comment) and
 * `lastSep` naming the `&&` / `|` separator before the final segment,
 * both so checkSafeCommand can explain comment-caused empty segments —
 * or `{ ok: false, reason }` naming the exact offending character or
 * operator when the command must be rejected.
 */
function checkComposition(
  command: string,
):
  | { segments: string[]; commentAt?: number; lastSep?: "&&" | "|" }
  | { ok: false; reason: string } {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let commentAt: number | undefined;
  let lastSep: "&&" | "|" | undefined;
  // Whether an unquoted `#` at this position would begin a word (and so
  // start a comment). True at the start of the command and right after
  // whitespace or a `|` / `&&` separator.
  let atWordStart = true;
  const reject = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      // single quotes: everything is literal
      current += ch;
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      // double quotes: $ and backticks are still active in bash
      if (ch === "$" || ch === "`") {
        return reject(
          `unquoted ${JSON.stringify(ch)} inside double quotes still expands in bash — not allowed in plan mode; single-quote it or remove it`,
        );
      }
      current += ch;
      if (ch === "\\") {
        // escaped char is literal; consume it too
        if (i + 1 < command.length) {
          current += command[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') quote = null;
      atWordStart = false;
      continue;
    }
    // unquoted
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      atWordStart = false;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) {
        // backslash escapes the next char (it is literal, whatever it is)
        current += ch;
        current += command[i + 1];
        i++;
        atWordStart = false;
      } else {
        return reject("command ends with a lone unquoted backslash — remove it");
      }
      continue;
    }
    // An unquoted `#` that starts a word begins a comment: everything to
    // the end of the command is ignored (mirrors bash — `ls # rm -rf /`
    // validates as just `ls`). Record where, so comment-caused empty
    // segments can be explained.
    if (ch === "#" && atWordStart) {
      commentAt = i;
      break;
    }
    if (ch === " " || ch === "\t") {
      current += ch;
      atWordStart = true;
      continue;
    }
    if (ch === ";" || ch === "$" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      return reject(
        `unquoted ${JSON.stringify(ch)} ${METACHAR_MEANING[ch]} — not allowed in plan mode; quote it or remove it`,
      );
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        segments.push(current);
        current = "";
        lastSep = "&&";
        atWordStart = true;
        i++;
        continue;
      }
      return reject("unquoted & is backgrounding (or |& / &>) — not allowed in plan mode; remove it");
    }
    if (ch === "|") {
      const next = command[i + 1];
      if (next === "|") return reject("unquoted || is not allowed in plan mode — only && and single pipelines | are allowed");
      if (next === "&") return reject("unquoted |& merges stderr into the pipeline — not allowed in plan mode");
      segments.push(current);
      current = "";
      lastSep = "|";
      atWordStart = true;
      continue;
    }
    current += ch;
    atWordStart = false;
  }
  if (quote !== null) return reject("unterminated quote — close the quote");
  segments.push(current);
  const out: { segments: string[]; commentAt?: number; lastSep?: "&&" | "|" } = { segments };
  if (commentAt !== undefined) out.commentAt = commentAt;
  if (lastSep !== undefined) out.lastSep = lastSep;
  return out;
}

/**
 * Quote-aware word tokenizer, mirroring checkComposition's scanner rules:
 * single-quoted text is fully literal and dequoted; double-quoted text
 * processes backslash escapes and is dequoted; an unquoted backslash \X
 * yields X; whitespace separates words. Returns null on an unterminated
 * quote or trailing backslash (fail closed).
 */
function tokenizeWords(input: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let inWord = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        if (i + 1 < input.length) {
          current += input[i + 1];
          i++;
        } else {
          current += "\\";
        }
      } else {
        current += ch;
      }
      inWord = true;
      continue;
    }
    // unquoted
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < input.length) {
        current += input[i + 1];
        i++;
      } else {
        return null; // trailing backslash
      }
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (quote !== null) return null; // unterminated quote
  if (inWord) words.push(current);
  return words;
}

/**
 * True when `segment` contains an unquoted, unescaped `{` or `}`
 * (brace-expansion metacharacters that can construct find flags).
 */
function hasUnquotedBrace(segment: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++; // escaped char is literal inside double quotes
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++; // escaped char is literal
      continue;
    }
    if (ch === "{" || ch === "}") return true;
  }
  return false;
}

/**
 * Validate a single (already split) command segment: bare allowlisted head
 * only. Returns the reason for the FIRST failing check, or `{ ok: true }`.
 * Check order is fixed (do not reorder — it decides which reason fires):
 *   1. empty / length > 2000
 *   2. unquoted word-initial `~`
 *   3. unquoted `{` / `}` (brace expansion)
 *   4. tokenization failure (unterminated quote / trailing backslash)
 *   5. COMMAND_FLAG_DENY[head] on dequoted tokens
 *   6. git: subcommand allowlist → subcommand flag deny → symbolic-ref
 *      query form → network-looking args (dequoted)
 *   7. find: write/exec flags on dequoted tokens
 *   8. uniq: at most one positional (second is the OUTPUT file)
 *   9. head allowlist (raw head; a quoted head fails closed)
 */
function checkSafeSegment(
  segment: string,
  allowed: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = segment.trim();
  if (!trimmed) {
    return { ok: false, reason: "segment is empty" };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: `segment exceeds the 2000-char length limit (${trimmed.length} chars)` };
  }
  const words = trimmed.split(/\s+/);
  const head = words[0] ?? "";

  // Unquoted word-initial `~` would be expanded by bash. A quoted `'~'`
  // starts with a quote character, so it never trips this check.
  const tildeWord = words.find((w) => w.startsWith("~"));
  if (tildeWord !== undefined) {
    return {
      ok: false,
      reason: `unquoted ${JSON.stringify(tildeWord)} starts with ~ which bash expands to a home directory — not allowed in plan mode; quote it ('~') or remove it`,
    };
  }

  // Brace expansion can construct denied flags from benign-looking pieces
  // (`-{d,d}elete` → `-delete`, `--p{re,re}=/bin/bash` → two `--pre=/bin/bash`
  // copies — verified live against bash). Reject any unquoted `{` / `}` in
  // every segment, not just `find`, so no command can smuggle a flag this way.
  if (hasUnquotedBrace(trimmed)) {
    return {
      ok: false,
      reason: "unquoted { } (brace expansion) can construct denied flags — not allowed in plan mode; quote or remove the braces",
    };
  }

  // Dequote argument words so quoted/escaped forms ('-o', "-o", --'output',
  // --outp\ut=...) are tested as the flags bash will actually pass. Head and
  // subcommand allowlist checks stay on the raw words (a quoted head fails
  // closed); only the flag/remote regexes run on dequoted tokens.
  const tokens = tokenizeWords(trimmed);
  if (!tokens) {
    return { ok: false, reason: "unterminated quote or trailing backslash — fix the quoting" };
  }

  // Write/exec-capable flags on otherwise allowlisted commands (like FIND_DANGEROUS).
  const deny = COMMAND_FLAG_DENY[head];
  if (deny) {
    const hit = firstFlagHit(tokens.slice(1), deny, COMMAND_FLAG_DENY_REASONS[head]);
    if (hit) {
      return { ok: false, reason: `${head} ${hit.token} ${hit.reason} — not allowed in plan mode; drop it` };
    }
  }

  if (head === "git") {
    if (words.length < 2) {
      return { ok: false, reason: `git needs a subcommand — allowed read-only subcommands: ${GIT_SUBCOMMANDS_TEXT}` };
    }
    const sub = words[1];
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `git ${sub} is not an allowed read-only subcommand in plan mode — allowed: ${GIT_SUBCOMMANDS_TEXT}`,
      };
    }
    const subDeny = GIT_SUBCOMMAND_FLAG_DENY[sub];
    if (subDeny) {
      const hit = firstFlagHit(tokens.slice(1), subDeny, GIT_SUBCOMMAND_FLAG_DENY_REASONS[sub]);
      if (hit) {
        return { ok: false, reason: `git ${sub} ${hit.token} ${hit.reason} — not allowed in plan mode; drop it` };
      }
    }
    if (sub === "symbolic-ref" && !isSafeSymbolicRef(tokens)) {
      return {
        ok: false,
        reason: "git symbolic-ref is allowed only in query form (no <ref> argument, no --delete) — the update form writes .git/HEAD",
      };
    }
    const remote = tokens.slice(1).find((w) => GIT_REMOTE.test(w));
    if (remote !== undefined) {
      return {
        ok: false,
        reason: `${JSON.stringify(remote)} looks like a network remote (URL or scp-style) — not allowed in plan mode; git here is read-only and local`,
      };
    }
    return { ok: true };
  }
  if (head === "find") {
    // Dequoted tokens, so obfuscated flags like '-delete', "-exec", -\delete,
    // or -e'xec' are tested as the plain flag they expand to.
    const hit = tokens.slice(1).find((w) => FIND_DANGEROUS.test(w));
    if (hit !== undefined) {
      return {
        ok: false,
        reason: `find ${hit} writes or executes — not allowed in plan mode; drop it (find is read-only here)`,
      };
    }
    return { ok: true };
  }
  if (head === "uniq") {
    // uniq [OPTION]... [INPUT [OUTPUT]] — the second positional is the OUTPUT
    // file, a content-controlled write (adjacent-duplicate removal passes the
    // agent's own plan-file content through verbatim, so `uniq PLAN.md
    // ~/.bashrc` overwrites an arbitrary path). Allow at most one positional.
    // Options taking a separate value (-f/-s/-w and their long forms) consume
    // it, so `uniq -f 2 file` stays read-only; `--` makes the rest positional.
    let positionals = 0;
    let afterDoubleDash = false;
    for (let i = 1; i < tokens.length; i++) {
      const w = tokens[i];
      if (afterDoubleDash) {
        positionals++;
        continue;
      }
      if (w === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (
        w === "-f" || w === "-s" || w === "-w" ||
        w === "--skip-fields" || w === "--skip-chars" || w === "--check-chars"
      ) {
        i++; // value is the next token (attached -fN / --opt=N forms never reach here)
        continue;
      }
      if (w.startsWith("-")) continue; // other flags: -c -d -D -i -u -z --count ...
      positionals++;
    }
    if (positionals >= 2) {
      return {
        ok: false,
        reason: "uniq allows at most one input file — the second positional is the output file, a write; drop it",
      };
    }
    return { ok: true };
  }
  if (!allowed.has(head)) {
    if (head.startsWith("'") || head.startsWith('"')) {
      return { ok: false, reason: `quoted command name ${JSON.stringify(head)} is not allowed in plan mode — unquote it` };
    }
    return {
      ok: false,
      reason: `${head} is not allowlisted in plan mode (read-only commands only) — grant it via profile bash additions, or note the action in the plan and run it via /plan go`,
    };
  }
  return { ok: true };
}

/**
 * A command is safe iff every segment of its composition (`a | b`,
 * `a && b`, or any mix) passes the standalone checks — bare allowlisted
 * head, no interpretable metacharacters, no `find` write/exec flags.
 * `;`, `||`, backgrounding `&`, and empty segments are always rejected;
 * quoted text is literal (except `$`/backticks in double quotes).
 * `extraCommands` extends the allowlist (profile bash commands).
 *
 * Returns the reason of the FIRST failing check — the same short-circuit
 * order the old boolean used, so `isSafeCommand` (below) is behaviorally
 * identical by construction. The reason names the exact offending
 * token/character and what to change; it is what the plan-mode gate
 * shows the agent when a command is blocked. Multi-segment commands get
 * an `in segment N ("…")` prefix when there are ≥2 segments.
 */
export function checkSafeCommand(
  command: string,
  extraCommands?: Iterable<string>,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, reason: "command is empty — send a real command" };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: `command exceeds the 2000-char length limit (${trimmed.length} chars) — shorten it` };
  }
  if (FORBIDDEN_ALWAYS.test(trimmed)) {
    return { ok: false, reason: "command contains newlines or control characters — not allowed in plan mode; send a single-line command" };
  }
  const composed = checkComposition(trimmed);
  if (!("segments" in composed)) return composed; // { ok: false, reason }
  const { segments, commentAt, lastSep } = composed;
  if (segments.length === 0) {
    return { ok: false, reason: "command is empty — send a real command" };
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].trim() !== "") continue;
    const where = lastSep ? `after ${JSON.stringify(lastSep)}` : "at the start of the command";
    if (commentAt !== undefined) {
      return {
        ok: false,
        reason: `empty segment ${where} — an unquoted # at word start begins a comment and bash ignores the rest of the command; move or quote the comment, or complete the composition`,
      };
    }
    return { ok: false, reason: `empty segment ${where} — complete the composition` };
  }
  const allowed = extraCommands
    ? new Set([...SAFE_COMMANDS, ...extraCommands])
    : SAFE_COMMANDS;
  for (let i = 0; i < segments.length; i++) {
    const res = checkSafeSegment(segments[i], allowed);
    if (!res.ok) {
      if (segments.length >= 2) {
        return { ok: false, reason: `in segment ${i + 1} (${JSON.stringify(segments[i].trim())}): ${res.reason}` };
      }
      return res;
    }
  }
  return { ok: true };
}

/** Boolean verdict of checkSafeCommand — identical behavior by construction. */
export function isSafeCommand(command: string, extraCommands?: Iterable<string>): boolean {
  return checkSafeCommand(command, extraCommands).ok;
}

/**
 * Full gate reason for a blocked bash command — the `block.reason` the
 * plan-mode `tool_call` gate returns (the text the model sees). Returns
 * null when the command is safe. `label` is the `[plan mode …]` prefix
 * from index.ts modeLabel(); `extraCommands` extends the allowlist
 * exactly like checkSafeCommand / isSafeCommand.
 *
 * Keep the wording in sync with checkSafeCommand / checkSafeSegment /
 * checkComposition (same file, above) — the reason line is their
 * first-failure output, never a parallel re-implementation.
 */
export function bashBlockReason(
  command: string,
  extraCommands?: Iterable<string>,
  label?: string,
): string | null {
  const check = checkSafeCommand(command, extraCommands);
  if (check.ok) return null;
  const prefix = label ? `[${label}] ` : "";
  return (
    `${prefix}${check.reason}\n` +
    `Blocked: ${command}\n` +
    `Full rules: see BASH RULES in your plan-mode instructions.\n` +
    `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`
  );
}

/**
 * Human-readable plan-mode bash rules for the agent prompt. The allowed
 * heads and git subcommands come from the live enforcement constants
 * (`SAFE_COMMANDS`, `SAFE_GIT_SUBCOMMANDS`), so the prompt can never drift
 * from the gate. The deny-rules text mirrors `COMMAND_FLAG_DENY` /
 * `FIND_DANGEROUS` / `GIT_REMOTE` / `checkComposition` above — keep it in
 * sync when changing the gate.
 */
export function describePlanModeBashRules(extraCommands?: Iterable<string>): string {
  const heads = [...SAFE_COMMANDS].sort().join(", ");
  const git = [...SAFE_GIT_SUBCOMMANDS].sort().join("|");
  const lines = [
    "SAFE BASH HEADS (bare command names; every | or && segment must pass the same checks):",
    heads,
    `git subcommands: ${git}`,
    "",
    "DENIED EVEN ON ALLOWED HEADS:",
    "- write/exec-capable flags: sort -o/--output and --compress-program, yq -i/--inplace, git diff/log --output=..., rg --pre/--pager (quoted or escaped forms too)",
    "- git grep -O / --open-files-in-pager (runs an arbitrary pager command on matching files); git diff -O<orderfile> stays allowed",
    "- git symbolic-ref only in query form (no <ref> argument, no --delete — the update form writes .git/HEAD)",
    "- uniq with two or more file arguments (the second positional is the output file — a content-controlled write); one input file (or none) is fine",
    "- tree -o/--output-file (writes the listing to a file instead of stdout)",
    "- tty-dependent write/exec flags (defense-in-depth): less -o/-O/--log-file, bat --pager",
    "- find flags that write or execute: -exec, -execdir, -ok, -delete, -fprint... (quoted, escaped, or brace-obfuscated forms too)",
    "- unquoted { } brace expansion in any segment (can construct denied flags; quoted braces are fine)",
    "- network-looking git arguments (URLs, scp-style remotes); git ls-remote is not allowed",
    '- unquoted word-initial ~ (bash would expand it; a quoted \'~\' is fine)',
    "- an unquoted # that starts a word begins a comment: the rest of the command is ignored (do not hide commands behind it)",
    "- a command ending in a lone unquoted backslash",
    "- composition metacharacters: ; || & $ ` < > ( ) and newlines; $ and backticks also inside double quotes",
    "",
    "NEVER ALLOWED: anything that writes, executes other commands, or touches the network",
    "(rm, touch, mkdir, sed, awk, xargs, env, curl, wget, ssh, sudo, git push/checkout/...).",
  ];
  if (extraCommands) {
    const additions = [...new Set(extraCommands)].join(", ");
    if (additions) lines.push("", `Profile bash additions: ${additions}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface PlanModeProfile {
  /** Short description shown in /plan completions and status. */
  description?: string;
  /** Extra tool names allowed in plan mode (MCP or extension tools). Exact names or `*`-suffix globs. */
  tools?: string[];
  /** Extra bare bash command names allowed through the gate (e.g. "julia"). */
  bash?: string[];
  /** Extra paths allowed for edit/write besides the plan file (relative to project root). */
  writePaths?: string[];
}

export interface PlanModeConfig {
  /** Plan file path, relative to the project root. Default: PLAN.md */
  planFile?: string;
  /**
   * Reasoning/thinking effort used while plan mode is on. Maps to pi's
   * thinking level (clamped to the current model's capabilities) and is
   * restored to the previous level when plan mode turns off.
   * Values: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
   */
  reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** User-defined plan-mode profiles (deep-merged by name: global → project). */
  profiles?: Record<string, PlanModeProfile>;
}

const CONFIG_FILE = "plan-mode.json";

/** Merge profile maps by name (later layers win per-field; arrays replace). */
export function mergeProfiles(
  ...layers: Array<Record<string, PlanModeProfile> | undefined>
): Record<string, PlanModeProfile> | undefined {
  const merged: Record<string, PlanModeProfile> = {};
  let any = false;
  for (const layer of layers) {
    if (!layer) continue;
    any = true;
    for (const [name, profile] of Object.entries(layer)) {
      merged[name] = { ...merged[name], ...profile };
    }
  }
  return any ? merged : undefined;
}

/** True when `p` is `base` itself or a descendant of `base` (lexical). */
function isInside(base: string, p: string): boolean {
  if (p === base) return true;
  const prefix = base === "/" ? "/" : base + sep;
  return p.startsWith(prefix);
}

/** env -> global config (~/.pi/agent/plan-mode.json) -> project config (.pi/plan-mode.json) */
export function loadConfig(cwd: string): PlanModeConfig {
  const merged: PlanModeConfig = {};
  const profiles: Array<Record<string, PlanModeProfile>> = [];
  const globalPath = join(getAgentDir(), CONFIG_FILE);
  const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
  for (const p of [globalPath, projectPath]) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as PlanModeConfig;
      if (p === projectPath && parsed.planFile !== undefined) {
        // The project config ships with the (possibly untrusted) checkout;
        // a planFile resolving outside the project would let edit/write treat
        // an arbitrary path as "the plan file" with no opt-in beyond /plan
        // (AUDIT R9). Constrain it to the project — only the global,
        // user-owned config may point the plan file elsewhere. Compare
        // canonical forms so symlinked subdirs cannot escape either.
        if (isInside(canonicalPath(cwd), canonicalPath(resolve(cwd, parsed.planFile)))) {
          merged.planFile = parsed.planFile;
        } else {
          console.warn(
            `[plan-mode] ignoring project planFile "${parsed.planFile}": must resolve inside ${cwd}`,
          );
        }
      } else {
        Object.assign(merged, parsed);
      }
      if (parsed.profiles) profiles.push(parsed.profiles);
    } catch (e) {
      console.error(`[plan-mode] Could not parse ${p}: ${e instanceof Error ? e.message : e}`);
    }
  }
  merged.profiles = mergeProfiles(...profiles);
  return merged;
}

/**
 * Expand a profile `tools` entry to concrete tool names. Supports exact
 * names and `*`-suffix globs (e.g. "kaimon*"). Returns [] when nothing
 * matches — the caller reports the entry as unknown.
 */
export function expandToolEntry(entry: string, available: ReadonlySet<string>): string[] {
  if (entry.endsWith("*")) {
    const prefix = entry.slice(0, -1);
    return [...available].filter((n) => n.startsWith(prefix));
  }
  return available.has(entry) ? [entry] : [];
}

/**
 * Build the effective plan-mode tool allowlist: base tools + profile tools
 * (filtered to the available ones). Returns the unknown/unmatched entries
 * so the caller can warn about them at profile activation.
 */
export function buildPlanModeTools(
  base: readonly string[],
  profile: PlanModeProfile | undefined,
  available: ReadonlySet<string>,
): { tools: string[]; unknown: string[] } {
  const tools = [...base];
  const unknown: string[] = [];
  if (profile?.tools) {
    for (const entry of profile.tools) {
      const matches = expandToolEntry(entry, available);
      if (matches.length === 0) {
        unknown.push(entry);
        continue;
      }
      for (const m of matches) {
        if (!tools.includes(m)) tools.push(m);
      }
    }
  }
  return { tools, unknown };
}

/* ------------------------------------------------------------------ */
/* Plan file                                                           */
/* ------------------------------------------------------------------ */

export function getPlanFilePath(cwd: string, config: PlanModeConfig): string {
  return config.planFile ? resolve(cwd, config.planFile) : join(cwd, "PLAN.md");
}

/**
 * Resolve a candidate plan-file path against `cwd` and return the absolute
 * path only if it stays inside `cwd`. Returns `null` when `planFile` is
 * empty or escapes the project.
 *
 * This is the same canonical `isInside` check `loadConfig` applies to a
 * project config's `planFile` (AUDIT R9): comparing canonical forms means
 * a `..` climb or a symlinked subdir cannot escape the project. It backs
 * the `/plan file <name>` subcommand and the `--plan-file` startup flag,
 * so a session-selected plan file is held to the same constraint as a
 * project-shipped one. Absolute paths that happen to resolve inside `cwd`
 * are accepted (they are just the project); paths outside are rejected.
 */
export function resolvePlanFileIn(cwd: string, planFile: string): string | null {
  if (!planFile.trim()) return null;
  const resolved = resolve(cwd, planFile);
  return isInside(canonicalPath(cwd), canonicalPath(resolved)) ? resolved : null;
}

/**
 * Canonicalize `p` by resolving symlinks as far as the filesystem allows.
 * `realpathSync(p)` resolves every existing component; when `p` (or an
 * ancestor) does not exist yet — the common case for an edit/write target
 * about to be created — walk up to the deepest existing ancestor,
 * canonicalize that, and re-append the missing components lexically. This
 * keeps non-existent paths lexical while still detecting symlink escapes.
 *
 * A missing component that is itself a symlink (a *dangling* link) is
 * resolved with `readlinkSync` and its target canonicalized instead of
 * being treated lexically: `writeFileSync` follows the link and creates the
 * target, so comparing the link's own path would let a dangling symlink
 * escape the allowed set. Recursion is depth-capped (mirroring the kernel's
 * ELOOP limit); a cyclic chain is returned unresolved, which is safe
 * because the write itself fails with ELOOP.
 *
 * NOTE: there is a residual TOCTOU race — a symlink swapped in between this
 * check and the actual write is not caught. That is accepted for a
 * model-facing gate (plan file and writePaths are user-configured, not an
 * OS-level sandbox).
 *
 * Hardlinks are likewise not detected: `realpath` cannot see them (same
 * inode, different path), so a hardlink planted inside an allowed directory
 * writes through to its linked target (AUDIT R12). Same accepted-risk family
 * as the TOCTOU race — requires attacker filesystem access or a crafted
 * tarball, and cannot be distinguished from a legitimately shared file.
 */
const MAX_SYMLINK_DEPTH = 40;
function canonicalPath(p: string, depth = 0): string {
  try {
    return realpathSync(p);
  } catch {
    // not all components exist (or p is a dangling/cyclic symlink) — fall through
  }
  if (depth >= MAX_SYMLINK_DEPTH) return p;
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const base = realpathSync(current);
      let result = base;
      for (let i = missing.length - 1; i >= 0; i--) result = join(result, missing[i]);
      return result;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // reached the filesystem root
      try {
        // `current` is a dangling symlink: canonicalize its target, then
        // re-append the components that were deeper than it.
        const link = readlinkSync(current);
        let result = canonicalPath(resolve(dirname(current), link), depth + 1);
        for (let i = missing.length - 1; i >= 0; i--) result = join(result, missing[i]);
        return result;
      } catch {
        // not a symlink — a plain not-yet-created component; keep walking up
        missing.push(basename(current));
        current = parent;
      }
    }
  }
}

/**
 * True when `p` exists and is a symbolic link — including a *dangling* one
 * (`lstat` reports the link itself, so this does not need the target to
 * exist). Used to fail closed before writing the plan file directly:
 * `writeFileSync` would follow a symlinked PLAN.md and clobber its target.
 */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false; // does not exist — a write will create a regular file
  }
}

/**
 * True when `rawPath` (an edit/write target, possibly with a leading `@`)
 * is the plan file itself or resolves inside one of the profile's
 * `writePaths` directories (resolved against `cwd`). The target and each
 * `writePaths` base are canonicalized before comparing, so a symlink inside
 * an allowed directory cannot escape the allowed set, and `..` escapes land
 * outside the set and are rejected. The plan file is compared at its
 * lexical resolved path (only symlinks in its containing directories are
 * canonicalized), so a PLAN.md that is itself a symlink out of the tree is
 * rejected rather than silently followed.
 */
export function isAllowedWritePath(
  cwd: string,
  planFile: string,
  writePaths: string[] | undefined,
  rawPath: string,
): boolean {
  const resolved = canonicalPath(resolve(cwd, String(rawPath ?? "").replace(/^@/, "")));
  const plan = join(canonicalPath(dirname(planFile)), basename(planFile));
  if (resolved === plan) return true;
  if (!writePaths) return false;
  for (const p of writePaths) {
    const base = canonicalPath(resolve(cwd, p));
    if (resolved === base) return true;
    const prefix = base === "/" ? "/" : base + "/";
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

export const PLAN_TEMPLATE = `# Plan

## Goal

(What are we building or fixing?)

## Context

(Constraints, research findings, decisions)

## Steps

- [ ] Step 1
- [ ] Step 2
`;

/* ------------------------------------------------------------------ */
/* Plan widget                                                         */
/* ------------------------------------------------------------------ */

/** Minimal theme surface needed to render the plan widget. */
export interface PlanWidgetTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/**
 * Human-readable summary of what activating a profile grants, for the
 * activation notify — the profile's own `description` is attacker-authored,
 * so the actual grants must be shown (AUDIT R9). Returns one line per grant
 * category (bash commands, tools, write paths), or [] when there are none.
 */
export function describeProfileGrants(profile: PlanModeProfile): string[] {
  const lines: string[] = [];
  if (profile.bash?.length) lines.push(`bash: ${[...new Set(profile.bash)].join(", ")}`);
  if (profile.tools?.length) lines.push(`tools: ${[...new Set(profile.tools)].join(", ")}`);
  if (profile.writePaths?.length) lines.push(`write paths: ${[...new Set(profile.writePaths)].join(", ")}`);
  return lines;
}

/**
 * Build a `MarkdownTheme` from a pi `Theme` instance (instance-based, so
 * runtime theme switches are respected; pi's own `getMarkdownTheme()` binds
 * the module-global theme). Used by the full-screen plan viewer's pi-tui
 * `Markdown` component. Type-only import of `MarkdownTheme` keeps utils.ts
 * runtime-dependency-free.
 */
export function buildMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
}

/**
 * `EditorTheme` for the embedded plan editor — mirrors pi's own
 * `getEditorTheme()` but bound to the passed `Theme` instance.
 */
export function buildEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

/**
 * pi's TUI caps widget line arrays at this many lines
 * (`InteractiveMode.MAX_WIDGET_LINES`); beyond it, the TUI appends its own
 * "(widget truncated)" marker. Keep every widget within this cap.
 */
export const TUI_WIDGET_LINE_CAP = 10;

/**
 * Build the plan widget: a single status line showing the plan file, the
 * line count, and the toggle key for the full-screen viewer. One line stays
 * far under the TUI's widget cap (`TUI_WIDGET_LINE_CAP`); the full plan is
 * shown in the viewer (`Alt+O` / `/plan open`).
 */
export function buildWidgetLines(
  planContent: string,
  planFile: string,
  toggleKey: string,
  theme: PlanWidgetTheme,
): string[] {
  const total = planContent.split("\n").length;
  const header =
    theme.bold("📋 Plan") +
    " " +
    theme.fg("muted", planFile) +
    " " +
    theme.fg("dim", `· ${total} lines · ${toggleKey} to view`);
  return [header];
}


