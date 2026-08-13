/**
 * Plan mode helpers: read-only bash validation, config loading, and the
 * DeepSeek-backed web search client (Responses API `web_search` tool).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

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
  "symbolic-ref", "name-rev", "help", "version", "ls-tree", "ls-remote", "grep",
]);

/** `find` flags that mutate the filesystem or execute commands. */
const FIND_DANGEROUS = /^-?(exec|execdir|ok|okdir|delete|fprint|fprint0|fls|fprintf)/;

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
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      // single quotes: everything is literal
      current += ch;
      if (ch === "'") quote = null;
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
      continue;
    }
    // unquoted
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      // backslash escapes the next char (it is literal, whatever it is)
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }
    if (ch === ";" || ch === "$" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      return null;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        segments.push(current);
        current = "";
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
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null; // unterminated quote — fail closed
  segments.push(current);
  return segments;
}

/** Validate a single (already split) command segment: bare allowlisted head only. */
function isSafeSegment(segment: string, allowed: ReadonlySet<string>): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  const words = trimmed.split(/\s+/);
  const head = words[0] ?? "";
  if (head === "git") {
    return words.length >= 2 && SAFE_GIT_SUBCOMMANDS.has(words[1]);
  }
  if (head === "find") {
    return words.slice(1).every((w) => !FIND_DANGEROUS.test(w));
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
  /** DeepSeek API key for web search. Falls back to DEEPSEEK_API_KEY, then the `deepseek` provider's key. */
  apiKey?: string;
  /** DeepSeek API base URL. Default: https://api.deepseek.com */
  baseUrl?: string;
  /** Model used for web search. Default: deepseek-v4-flash */
  model?: string;
  /** Plan file path, relative to the project root. Default: PLAN.md */
  planFile?: string;
  /** Lines shown when the plan display is collapsed. Default: 5 */
  collapsedLines?: number;
  /** Web search timeout in ms. Default: 30000 */
  searchTimeoutMs?: number;
  /** DeepSeek reasoning effort for searches: "off" | "low" | "high". Default: "low" */
  reasoningEffort?: "off" | "low" | "high";
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
  if (process.env.DEEPSEEK_API_KEY) merged.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE_URL) merged.baseUrl = process.env.DEEPSEEK_BASE_URL;
  if (process.env.DEEPSEEK_MODEL) merged.model = process.env.DEEPSEEK_MODEL;
  return merged;
}

export function getCollapsedLines(config: PlanModeConfig): number {
  const n = config.collapsedLines ?? 5;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
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
 * True when `rawPath` (an edit/write target, possibly with a leading `@`)
 * is the plan file itself or resolves inside one of the profile's
 * `writePaths` directories (resolved against `cwd`). Exact resolved-path
 * comparison means `..` escapes land outside the set and are rejected.
 */
export function isAllowedWritePath(
  cwd: string,
  planFile: string,
  writePaths: string[] | undefined,
  rawPath: string,
): boolean {
  const resolved = resolve(cwd, String(rawPath ?? "").replace(/^@/, ""));
  if (resolved === planFile) return true;
  if (!writePaths) return false;
  for (const p of writePaths) {
    const base = resolve(cwd, p);
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
 * pi's TUI caps widget line arrays at this many lines
 * (`InteractiveMode.MAX_WIDGET_LINES`); beyond it, the TUI appends its own
 * "(widget truncated)" marker. Keep every widget within this cap.
 */
export const TUI_WIDGET_LINE_CAP = 10;

/**
 * Build the plan widget lines: header (1) + up to `collapsedLines` plan
 * lines + hint (1) = always ≤ `TUI_WIDGET_LINE_CAP`. The full plan is too
 * large for the widget, so the hint points at the full-screen editor view
 * (`Alt+O` / `/plan open`).
 */
export function buildWidgetLines(
  planContent: string,
  planFile: string,
  collapsedLines: number,
  toggleKey: string,
  theme: PlanWidgetTheme,
): string[] {
  const lines = planContent.split("\n");
  const total = lines.length;
  const bodyLimit = Math.min(Math.max(collapsedLines, 1), TUI_WIDGET_LINE_CAP - 2);
  const header =
    theme.bold("📋 Plan") +
    " " +
    theme.fg("muted", planFile) +
    " " +
    theme.fg("dim", `· ${total} lines · ${toggleKey} to view`);
  const body = lines.slice(0, bodyLimit).map((l) => "  " + (l === "" ? " " : l));
  if (total <= bodyLimit) return [header, ...body];
  const hint = theme.fg(
    "dim",
    `  … ${total - bodyLimit} more line(s) — ${toggleKey} to view the full plan`,
  );
  return [header, ...body, hint];
}

/* ------------------------------------------------------------------ */
/* DeepSeek web search (Responses API)                                 */
/* ------------------------------------------------------------------ */

export interface WebSearchAction {
  type: "search" | "open_page" | "find_in_page";
  queries?: string[];
  url?: string;
}

export interface DeepSeekSearchResult {
  answer: string;
  actions: WebSearchAction[];
  sources: string[];
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
}

export interface DeepSeekSearchOptions {
  apiKey: string;
  query: string;
  baseUrl?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "off" | "low" | "high";
}

/** Filter query-array noise entries (e.g. "ws_call_id=..."). Exported for tests. */
export function cleanQueries(queries: unknown): string[] | undefined {
  if (!Array.isArray(queries)) return undefined;
  const cleaned = queries.filter(
    (q): q is string => typeof q === "string" && !q.startsWith("ws_call_id="),
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Strip the "#ws_call_id=..." suffix DeepSeek appends to opened URLs. Exported for tests. */
export function cleanUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  return url.split("#ws_call_id=")[0] ?? undefined;
}

/** Concatenate the synthesized answer from `final_answer` message items. */
function extractFinalAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as { type?: unknown; phase?: unknown; content?: unknown };
    if (it.type !== "message" || it.phase !== "final_answer") continue;
    if (!Array.isArray(it.content)) continue;
    for (const part of it.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "output_text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

function parseUsage(usage: unknown): DeepSeekSearchResult["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") {
    return undefined;
  }
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : u.input_tokens + u.output_tokens,
    reasoningTokens:
      typeof u.output_tokens_details?.reasoning_tokens === "number"
        ? u.output_tokens_details.reasoning_tokens
        : 0,
    cachedTokens:
      typeof u.input_tokens_details?.cached_tokens === "number" ? u.input_tokens_details.cached_tokens : 0,
  };
}

/**
 * Run a server-side web search via DeepSeek's /responses API.
 * DeepSeek executes the search (search / open_page / find_in_page) on its
 * servers and returns a synthesized answer with citations.
 */
export async function deepseekSearch(opts: DeepSeekSearchOptions): Promise<DeepSeekSearchResult> {
  const baseUrl = (opts.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model: opts.model ?? "deepseek-v4-flash",
      input: opts.query,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: opts.maxOutputTokens ?? 4096,
    };
    const effort = opts.reasoningEffort ?? "low";
    if (effort !== "off") body.reasoning = { effort };

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `DeepSeek web search failed: HTTP ${response.status}`;
      try {
        const err = (await response.json()) as { error?: { message?: string } };
        if (err.error?.message) message += ` — ${err.error.message}`;
      } catch {
        // ignore body parse errors
      }
      throw new Error(message);
    }

    const json = (await response.json()) as {
      output?: unknown[];
      usage?: unknown;
      model?: string;
    };
    const output = Array.isArray(json.output) ? json.output : [];

    const actions: WebSearchAction[] = [];
    const sources = new Set<string>();
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const it = item as { action?: unknown };
      if (!it.action || typeof it.action !== "object") continue;
      const a = it.action as { type?: unknown; queries?: unknown; url?: unknown };
      if (typeof a.type !== "string") continue;
      if (a.type === "search") {
        actions.push({ type: "search", queries: cleanQueries(a.queries) });
      } else if (a.type === "open_page" || a.type === "find_in_page") {
        const url = cleanUrl(a.url);
        if (url) sources.add(url);
        actions.push({ type: a.type, url });
      }
    }

    return {
      answer: extractFinalAnswer(output),
      actions,
      sources: [...sources],
      model: typeof json.model === "string" ? json.model : undefined,
      usage: parseUsage(json.usage),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** True when a web search is aborted by the caller (not a timeout). */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
