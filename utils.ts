/**
 * Plan mode helpers: read-only bash validation, config loading, profile
 * allowlist expansion, and plan-file write-path checks.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
 * Write-capable flags on otherwise allowlisted commands (like FIND_DANGEROUS).
 * Each key is a command head; any argument word matching one of its regexes
 * makes the segment unsafe.
 */
const COMMAND_FLAG_DENY: Record<string, RegExp[]> = {
  // GNU sort: -o / -o= / -oFILE and the long alias --output / --output= all write.
  sort: [/^(-o|--output)/],
  yq: [/^(-i|--inplace)($|=)/],
  // git --output=FILE writes; --output-indicator-* (diff formatting) stays allowed.
  git: [/^--output($|=)/],
};

/** git arguments that look like network remotes (URL or scp-style). */
const GIT_REMOTE = /^([a-z][a-z0-9+.-]*:\/\/|[^@\s]+@[^:\s]+:)/;

/** Control characters never allowed anywhere in a plan-mode command. */
const FORBIDDEN_ALWAYS = /[\r\n\x00]/;

/**
 * Scan a command and split it on *unquoted* `&&` operators and `|`
 * pipelines, rejecting metacharacters where bash would interpret them:
 * unquoted `;` `$` backtick `<` `>` `(` `)`; `$` and backticks also
 * inside double quotes (bash still expands them there); a lone `&`
 * (backgrounding, `|&`, `&>`); `||`; and unterminated quotes.
 * Single-quoted text is fully literal (backslashes included).
 * Returns null when the command must be rejected.
 */
function splitComposition(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  // Whether an unquoted `#` at this position would begin a word (and so
  // start a comment). True at the start of the command and right after
  // whitespace or a `|` / `&&` separator.
  let atWordStart = true;
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
      if (ch === "$" || ch === "`") return null;
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
        return null; // trailing backslash: unterminated escape
      }
      continue;
    }
    // An unquoted `#` that starts a word begins a comment: everything to
    // the end of the command is ignored (mirrors bash — `ls # rm -rf /`
    // validates as just `ls`).
    if (ch === "#" && atWordStart) {
      break;
    }
    if (ch === " " || ch === "\t") {
      current += ch;
      atWordStart = true;
      continue;
    }
    if (ch === ";" || ch === "$" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      return null;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        segments.push(current);
        current = "";
        atWordStart = true;
        i++;
        continue;
      }
      return null; // lone &: backgrounding, |&, &>
    }
    if (ch === "|") {
      const next = command[i + 1];
      if (next === "|" || next === "&") return null; // || or |&
      segments.push(current);
      current = "";
      atWordStart = true;
      continue;
    }
    current += ch;
    atWordStart = false;
  }
  if (quote !== null) return null; // unterminated quote — fail closed
  segments.push(current);
  return segments;
}

/**
 * Quote-aware word tokenizer, mirroring splitComposition's scanner rules:
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

/** Validate a single (already split) command segment: bare allowlisted head only. */
function isSafeSegment(segment: string, allowed: ReadonlySet<string>): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  const words = trimmed.split(/\s+/);
  const head = words[0] ?? "";

  // Unquoted word-initial `~` would be expanded by bash. A quoted `'~'`
  // starts with a quote character, so it never trips this check.
  if (words.some((w) => w.startsWith("~"))) return false;

  // Write-capable flags on otherwise allowlisted commands (like FIND_DANGEROUS).
  const deny = COMMAND_FLAG_DENY[head];
  if (deny && words.slice(1).some((w) => deny.some((re) => re.test(w)))) return false;

  if (head === "git") {
    return (
      words.length >= 2 &&
      SAFE_GIT_SUBCOMMANDS.has(words[1]) &&
      words.slice(1).every((w) => !GIT_REMOTE.test(w))
    );
  }
  if (head === "find") {
    // Brace expansion can construct flags (`-{d,d}elete` → `-delete`), so
    // reject any unquoted `{` / `}` in the segment.
    if (hasUnquotedBrace(trimmed)) return false;
    // Tokenize with dequoting so obfuscated flags like '-delete', "-exec",
    // -\delete, or -e'xec' are tested as the plain flag they expand to.
    const tokens = tokenizeWords(trimmed);
    if (!tokens) return false;
    return tokens.slice(1).every((w) => !FIND_DANGEROUS.test(w));
  }
  return allowed.has(head);
}

/**
 * A command is safe iff every segment of its composition (`a | b`,
 * `a && b`, or any mix) passes the standalone checks — bare allowlisted
 * head, no interpretable metacharacters, no `find` write/exec flags.
 * `;`, `||`, backgrounding `&`, and empty segments are always rejected;
 * quoted text is literal (except `$`/backticks in double quotes).
 * `extraCommands` extends the allowlist (profile bash commands).
 */
export function isSafeCommand(command: string, extraCommands?: Iterable<string>): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (FORBIDDEN_ALWAYS.test(trimmed)) return false;
  const segments = splitComposition(trimmed);
  if (!segments || segments.length === 0) return false;
  if (segments.some((s) => s.trim() === "")) return false;
  const allowed = extraCommands
    ? new Set([...SAFE_COMMANDS, ...extraCommands])
    : SAFE_COMMANDS;
  return segments.every((s) => isSafeSegment(s, allowed));
}

/**
 * Human-readable plan-mode bash rules for the agent prompt. The allowed
 * heads and git subcommands come from the live enforcement constants
 * (`SAFE_COMMANDS`, `SAFE_GIT_SUBCOMMANDS`), so the prompt can never drift
 * from the gate. The deny-rules text mirrors `COMMAND_FLAG_DENY` /
 * `FIND_DANGEROUS` / `GIT_REMOTE` / `splitComposition` above — keep it in
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
    "- write-capable flags: sort -o/--output, yq -i/--inplace, git diff/log --output=...",
    "- find flags that write or execute: -exec, -execdir, -ok, -delete, -fprint... (quoted, escaped, or brace-obfuscated forms too)",
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

/** env -> global config (~/.pi/agent/plan-mode.json) -> project config (.pi/plan-mode.json) */
export function loadConfig(cwd: string): PlanModeConfig {
  const merged: PlanModeConfig = {};
  const profiles: Array<Record<string, PlanModeProfile>> = [];
  const paths = [join(getAgentDir(), CONFIG_FILE), join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as PlanModeConfig;
      Object.assign(merged, parsed);
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
 * Canonicalize `p` by resolving symlinks as far as the filesystem allows.
 * `realpathSync(p)` resolves every existing component; when `p` (or an
 * ancestor) does not exist yet — the common case for an edit/write target
 * about to be created — walk up to the deepest existing ancestor,
 * canonicalize that, and re-append the missing components lexically. This
 * keeps non-existent paths lexical while still detecting symlink escapes.
 *
 * NOTE: there is a residual TOCTOU race — a symlink swapped in between this
 * check and the actual write is not caught. That is accepted for a
 * model-facing gate (plan file and writePaths are user-configured, not an
 * OS-level sandbox).
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // not all components exist yet — fall through
  }
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const base = realpathSync(current);
      let result = base;
      for (let i = tail.length - 1; i >= 0; i--) result = join(result, tail[i]);
      return result;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // reached the filesystem root
      tail.push(basename(current));
      current = parent;
    }
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


