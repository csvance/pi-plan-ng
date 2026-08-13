/**
 * Plan mode (v2) — Claude Code-style planning for pi.
 *
 * `/plan` enters plan mode: the agent's tools are restricted to reading
 * files, DeepSeek-backed web search, read-only bash, and writing ONLY the
 * plan file. Each turn the agent states what it's updating, updates the
 * plan in a markdown file (PLAN.md by default), and a compact preview is
 * shown in a widget above the editor. `Alt+O` opens the plan in a
 * full-screen editor to view, scroll, and edit it; saving writes the
 * changes back to the plan file.
 *
 * `/plan go` exits plan mode and executes the plan with full tool access.
 * Execution progress is tracked with todos (the `todo` tool from
 * pi-agent-extensions): each plan step becomes a todo tagged `plan`, and
 * the plan file itself is not edited while executing.
 * `/plan <profile>` enters plan mode with a user-defined profile that
 * extends the allowlist (extra tools, bash commands, write paths) — see
 * the "profiles" key in the plan-mode config.
 * `/plan clear` resets the plan file (with confirmation).
 * The plan file is never deleted on exit/re-entry; only an explicit,
 * user-confirmed reset replaces it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  buildWidgetLines,
  buildPlanModeTools,
  deepseekSearch,
  expandToolEntry,
  getCollapsedLines,
  getPlanFilePath,
  isAbort,
  isAllowedWritePath,
  isSafeCommand,
  loadConfig,
  PLAN_TEMPLATE,
  type DeepSeekSearchResult,
  type PlanModeProfile,
} from "./utils.ts";

/**
 * Tools available while plan mode is active (computed dynamically because
 * `web_search` may come from this extension or from an existing extension
 * such as pi-deepseek-search).
 */
const CONTEXT_CUSTOM_TYPE = "plan-mode-v2-context";
const STATE_CUSTOM_TYPE = "plan-mode-v2";

const TOGGLE_KEY = "Alt+O";

interface PlanModeState {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
  /** Active profile name (undefined = default, no profile). */
  profile?: string;
}

export default function (pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let toolsBeforePlanMode: string[] | undefined;
  let searchToolRegisteredByUs = false;
  let activeProfileName: string | undefined;
  let activeProfile: PlanModeProfile | undefined;
  /** sourceInfo.source of the tools THIS extension registers (web_search, plan_clear). */
  const ownToolSources = new Map<string, string>();

  /** Gate label used in block reasons and status, e.g. "plan mode (julia)". */
  function modeLabel(): string {
    return activeProfileName ? `plan mode (${activeProfileName})` : "plan mode";
  }

  function planModeTools(): string[] {
    const base = ["read", "grep", "find", "ls", "bash", "edit", "write", "plan_clear"];
    const available = new Set(pi.getAllTools().map((t) => t.name));
    if (available.has("web_search")) base.push("web_search");
    const { tools } = buildPlanModeTools(base, activeProfile, available);
    return tools;
  }

  /**
   * True when the `todo` tool (pi-agent-extensions) is available.
   * `/plan go` hard-requires it: todos track execution progress instead of
   * editing checkboxes in the plan file.
   */
  function hasTodoTool(): boolean {
    return pi.getAllTools().some((t) => t.name === "todo");
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (restricted, read-only planning)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("plan-profile", {
    description: "Start in plan mode with the named profile (see /plan status)",
    type: "string",
    default: "",
  });

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function persistState(): void {
    pi.appendEntry(STATE_CUSTOM_TYPE, {
      enabled: planModeEnabled,
      toolsBeforePlanMode,
      profile: activeProfileName,
    } satisfies PlanModeState);
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "plan-mode",
      planModeEnabled ? ctx.ui.theme.fg("warning", `⏸ plan${activeProfileName ? `·${activeProfileName}` : ""}`) : undefined,
    );
  }

  /**
   * Ensure the plan file exists, creating the template if needed.
   * Synchronous on purpose: command/event handlers must not await across
   * a ctx lifetime (session replacement invalidates captured ctx
   * objects).
   */
  function ensurePlanFile(cwd: string): string {
    const config = loadConfig(cwd);
    const planFile = getPlanFilePath(cwd, config);
    mkdirSync(dirname(planFile), { recursive: true });
    if (!existsSync(planFile)) {
      writeFileSync(planFile, PLAN_TEMPLATE, "utf8");
    }
    return planFile;
  }

  function refreshPlanWidget(ctx: ExtensionContext): void {
    if (!planModeEnabled) return;
    const config = loadConfig(ctx.cwd);
    const planFile = getPlanFilePath(ctx.cwd, config);
    let content: string;
    try {
      content = readFileSync(planFile, "utf8");
    } catch {
      content = PLAN_TEMPLATE;
    }
    ctx.ui.setWidget(
      "plan-mode",
      buildWidgetLines(content, planFile, getCollapsedLines(config), TOGGLE_KEY, ctx.ui.theme),
    );
  }

  /**
   * Resolve a profile by name (case-insensitive) from the merged config
   * (global → project). Returns the canonical config key too, so
   * `activeProfileName` always matches the config exactly.
   */
  function resolveProfile(
    ctx: ExtensionContext,
    name: string | undefined,
  ): { canonicalName: string | undefined; profile: PlanModeProfile | undefined } {
    if (!name) return { canonicalName: undefined, profile: undefined };
    const profiles = loadConfig(ctx.cwd).profiles ?? {};
    if (profiles[name]) return { canonicalName: name, profile: profiles[name] };
    const key = Object.keys(profiles).find((k) => k.toLowerCase() === name.toLowerCase());
    return key
      ? { canonicalName: key, profile: profiles[key] }
      : { canonicalName: undefined, profile: undefined };
  }

  /** Warn once per unknown profile tool entry (does not block activation). */
  function warnUnknownProfileTools(
    ctx: ExtensionContext,
    profileName: string | undefined,
    profile: PlanModeProfile | undefined,
  ): void {
    if (!profile?.tools || profile.tools.length === 0) return;
    const available = new Set(pi.getAllTools().map((t) => t.name));
    const { unknown } = buildPlanModeTools([], profile, available);
    for (const u of unknown) {
      ctx.ui.notify(
        `[plan mode] Profile "${profileName}" references unknown tool "${u}" — ignored.`,
        "warning",
      );
    }
    // Warn when a `*`-suffix glob expands to more than one tool, so the
    // user can see the blast radius of a broad allowlist entry.
    for (const entry of profile.tools) {
      if (!entry.endsWith("*")) continue;
      const matches = expandToolEntry(entry, available);
      if (matches.length > 1) {
        ctx.ui.notify(
          `[plan mode] Profile "${profileName}" tool glob "${entry}" expands to ${matches.length} tools: ${matches.join(", ")}.`,
          "warning",
        );
      }
    }
  }

  /**
   * Enter plan mode, optionally with a named profile. Returns false (and
   * leaves plan mode off) when the profile is unknown. Warns about profile
   * tools that do not exist in the current tool set.
   */
  function enablePlanMode(ctx: ExtensionContext, profileName?: string): boolean {
    const { canonicalName, profile } = resolveProfile(ctx, profileName);
    if (profileName && !profile) return false;
    ensureSearchTool();
    if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
    activeProfileName = canonicalName;
    activeProfile = profile;
    warnUnknownProfileTools(ctx, canonicalName, profile);
    pi.setActiveTools(planModeTools());
    planModeEnabled = true;
    persistState();
    updateStatus(ctx);
    refreshPlanWidget(ctx);
    return true;
  }

  function disablePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = false;
    activeProfileName = undefined;
    activeProfile = undefined;
    pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
    toolsBeforePlanMode = undefined;
    ctx.ui.setWidget("plan-mode", undefined);
    updateStatus(ctx);
    persistState();
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) {
      disablePlanMode(ctx);
      ctx.ui.notify("Plan mode off. The plan file is kept.", "info");
    } else {
      ensurePlanFile(ctx.cwd);
      enablePlanMode(ctx);
      const config = loadConfig(ctx.cwd);
      const todoOk = hasTodoTool();
      ctx.ui.notify(
        [
          `Plan mode on. Plan file: ${getPlanFilePath(ctx.cwd, config)}`,
          todoOk
            ? "Execution will track progress with todos (pi-agent-extensions)."
            : 'WARNING: the todos extension is not installed (`pi install pi-agent-extensions`) — /plan go will not run until it is.',
        ].join("\n"),
        todoOk ? "info" : "warning",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Commands                                                          */
  /* ---------------------------------------------------------------- */

  pi.registerCommand("plan", {
    description:
      "Toggle plan mode. Subcommands: go (execute plan), clear (reset plan), status, open. A profile name enters plan mode with that profile.",
    getArgumentCompletions: (prefix: string) => {
      const builtins = ["go", "clear", "status", "open"];
      const profiles = Object.keys(loadConfig(process.cwd()).profiles ?? {});
      return [...builtins, ...profiles]
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a }));
    },
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase();

      if (action === "go") {
        if (!hasTodoTool()) {
          ctx.ui.notify(
            'Execution tracks progress with todos, but the todos extension is not installed. Install it with `pi install pi-agent-extensions`, then /reload.',
            "warning",
          );
          return;
        }
        const planFile = ensurePlanFile(ctx.cwd);
        let content = "";
        try {
          content = readFileSync(planFile, "utf8");
        } catch {
          // fall through with empty content
        }
        if (!content.trim()) {
          ctx.ui.notify("The plan file is empty. Build a plan first (staying in plan mode), then run /plan go.", "warning");
          return;
        }
        const wasInPlanMode = planModeEnabled;
        disablePlanMode(ctx);
        pi.sendMessage(
          {
            customType: "plan-execute-v2",
            content: [
              "[EXECUTING PLAN]",
              "Full tool access has been restored. Execute the plan below, working through it step by step.",
              "",
              `Plan file: ${planFile} — the source of truth for WHAT to do.`,
              "",
              "TRACKING PROGRESS WITH TODOS:",
              "- Call todo list-all first to see which todos already exist.",
              '- If this plan was executed before, reuse the todos tagged "plan" that still match plan steps: update titles of changed steps (todo update) and delete stale ones (todo delete).',
              '- Otherwise create one todo per step: todo create with title = the step text, body = relevant context from the plan, tags = ["plan"].',
              "- Steps are the checklist items (- [ ]) in the plan file; if the plan has no checklist, break it into logical steps yourself.",
              '- Claim a todo (todo claim) before starting it, close it when finished (todo update with status "closed"), and append brief notes on what was done (todo append).',
              "- Do NOT edit the plan file while executing — todos are the source of truth for step state.",
              "",
              "--- PLAN ---",
              content.trim(),
              "--- END PLAN ---",
              "",
              "Start with the first step. When all todos are closed, summarize what was done.",
            ].join("\n"),
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        // sendMessage is fire-and-forget: stay in the command handler until the
        // triggered execution turn settles, so the run isn't torn down early
        // (and so /plan go reports when it finishes).
        await ctx.waitForIdle();
        ctx.ui.notify(
          wasInPlanMode ? "Plan mode off — execution finished." : "Execution finished.",
          "info",
        );
        return;
      }

      if (action === "clear") {
        const ok = await ctx.ui.confirm(
          "Reset plan?",
          "The plan file will be replaced with a fresh template. This cannot be undone. Continue?",
        );
        if (!ok) {
          ctx.ui.notify("Plan reset cancelled.", "info");
          return;
        }
        const planFile = ensurePlanFile(ctx.cwd);
        writeFileSync(planFile, PLAN_TEMPLATE, "utf8");
        if (planModeEnabled) refreshPlanWidget(ctx);
        ctx.ui.notify(`Plan reset: ${planFile}`, "info");
        return;
      }

      if (action === "status") {
        const config = loadConfig(ctx.cwd);
        const planFile = getPlanFilePath(ctx.cwd, config);
        const profileNames = Object.keys(config.profiles ?? {});
        const activeDesc = activeProfile?.description ? ` — ${activeProfile.description}` : "";
        ctx.ui.notify(
          [
            `Plan mode: ${planModeEnabled ? "ON" : "OFF"}`,
            `Profile: ${activeProfileName ?? "none (default)"}${activeDesc}`,
            `Available profiles: ${profileNames.length > 0 ? profileNames.join(", ") : "(none)"}`,
            `Plan file: ${planFile}`,
            `Web search: ${config.apiKey ? "configured" : "not configured (set DEEPSEEK_API_KEY or \"apiKey\" in .pi/plan-mode.json)"}`,
            `Todos: ${hasTodoTool() ? "available (pi-agent-extensions)" : "NOT installed — /plan go is disabled (`pi install pi-agent-extensions`)"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (action === "open") {
        await openPlanView(ctx);
        return;
      }

      // A non-empty argument that is not a built-in subcommand: enter plan
      // mode with that profile (or switch profile if already in plan mode).
      if (action !== "") {
        const { canonicalName, profile } = resolveProfile(ctx, action);
        if (!profile) {
          const names = Object.keys(loadConfig(ctx.cwd).profiles ?? {});
          ctx.ui.notify(
            [
              `Unknown profile: "${action}".`,
              `Available profiles: ${names.length > 0 ? names.join(", ") : "(none configured)"}`,
              "Define profiles in .pi/plan-mode.json (project) or ~/.pi/agent/plan-mode.json (global).",
            ].join("\n"),
            "warning",
          );
          return;
        }
        ensurePlanFile(ctx.cwd);
        const wasOn = planModeEnabled;
        const ok = enablePlanMode(ctx, canonicalName);
        if (!ok) {
          ctx.ui.notify(`Could not activate profile "${action}".`, "warning");
          return;
        }
        ctx.ui.notify(
          wasOn
            ? `Switched to profile "${canonicalName}" (${profile.description ?? "no description"}).`
            : `Plan mode on with profile "${canonicalName}" (${profile.description ?? "no description"}).`,
          "info",
        );
        return;
      }

      // bare /plan toggles
      togglePlanMode(ctx);
    },
  });

  /* ---------------------------------------------------------------- */
  /* Shortcut: open plan in the full-screen editor                     */
  /* ---------------------------------------------------------------- */

  /**
   * Open the plan file in the full-screen editor for viewing, scrolling,
   * and editing. pi's TUI caps widget arrays at 10 lines, so this is the
   * way to see the entire plan. Saving writes the changes back to the plan
   * file; cancelling (Esc) leaves it untouched.
   */
  async function openPlanView(ctx: ExtensionContext): Promise<void> {
    const planFile = ensurePlanFile(ctx.cwd);
    if (!ctx.hasUI) {
      ctx.ui.notify(`Plan file: ${planFile}`, "info");
      return;
    }
    let content: string;
    try {
      content = readFileSync(planFile, "utf8");
    } catch {
      content = PLAN_TEMPLATE;
    }
    const updated = await ctx.ui.editor(`Plan — ${planFile}`, content);
    if (updated === undefined) return; // cancelled — no changes
    if (updated !== content) {
      writeFileSync(planFile, updated, "utf8");
      if (planModeEnabled) refreshPlanWidget(ctx);
      ctx.ui.notify("Plan updated.", "info");
    }
  }

  pi.registerShortcut("alt+o", {
    description: "Open plan in full-screen editor (view/scroll/edit)",
    handler: (ctx) => void openPlanView(ctx),
  });

  /* ---------------------------------------------------------------- */
  /* Tools                                                             */
  /* ---------------------------------------------------------------- */

  // Approximate USD pricing for deepseek-v4-flash (tokens -> cost).
  const USD_PER_TOKEN = {
    input: 0.14 / 1_000_000,
    cachedInput: 0.003 / 1_000_000,
    output: 0.28 / 1_000_000,
  };

  function toPiUsage(usage: NonNullable<DeepSeekSearchResult["usage"]>) {
    const inputCost = usage.inputTokens * USD_PER_TOKEN.input;
    const cachedCost = (usage.cachedTokens ?? 0) * USD_PER_TOKEN.cachedInput;
    const outputCost = usage.outputTokens * USD_PER_TOKEN.output;
    return {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cachedTokens ?? 0,
      cacheWrite: 0,
      reasoning: usage.reasoningTokens ?? 0,
      totalTokens: usage.totalTokens,
      cost: {
        input: inputCost,
        cacheRead: cachedCost,
        cacheWrite: 0,
        output: outputCost,
        total: inputCost + cachedCost + outputCost,
      },
    };
  }

  function buildSearchContent(result: DeepSeekSearchResult, query: string): string {
    const parts: string[] = [`Web search results for "${query}":\n`];
    if (result.answer) parts.push(result.answer);
    if (result.sources.length > 0) {
      parts.push("\nSources:");
      for (const s of result.sources) parts.push(`- ${s}`);
    }
    const searches = [
      ...new Set(
        result.actions
          .filter((a) => a.type === "search" && a.queries && a.queries.length > 0)
          .flatMap((a) => a.queries as string[]),
      ),
    ];
    if (searches.length > 0) parts.push(`\nSearch actions: ${searches.join(" | ")}`);
    return parts.join("\n");
  }

  /**
   * Record the sourceInfo.source of a tool we just registered, so the gate
   * can tell our own web_search/plan_clear apart from lookalikes registered
   * by other extensions under the same name.
   */
  function captureOwnToolSource(name: string): void {
    const t = pi.getAllTools().find((x) => x.name === name);
    if (t?.sourceInfo?.source) ownToolSources.set(name, t.sourceInfo.source);
  }

  /**
   * Register our own DeepSeek-backed `web_search` tool. Only used when no
   * other extension already provides one (e.g. pi-deepseek-search).
   */
  function registerSearchTool(): void {
    pi.registerTool({
      name: "web_search",
      label: "Web Search (DeepSeek)",
      description:
        "Search the web via DeepSeek's server-side web search. Returns a synthesized answer with citations plus the search actions performed. Use for up-to-date, time-sensitive, or external information during planning.",
      promptSnippet: "Search the web (DeepSeek-backed) for up-to-date or external information",
      promptGuidelines: [
        "Use web_search when the user asks about time-sensitive or external information that is not in the local context.",
        "After a web_search call, base your answer on the returned content and cite the listed sources.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search query. Use specific keywords." }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const apiKey = await resolveSearchApiKey(ctx);
        if (!apiKey) {
          throw new Error(
            'No DeepSeek API key for web search. Set DEEPSEEK_API_KEY, add "apiKey" to .pi/plan-mode.json, or configure the deepseek provider (/login deepseek).',
          );
        }
        const config = loadConfig(ctx.cwd);
        try {
          const result = await deepseekSearch({
            apiKey,
            query: params.query,
            signal,
            baseUrl: config.baseUrl,
            model: config.model,
            timeoutMs: config.searchTimeoutMs,
            reasoningEffort: config.reasoningEffort,
          });
          const usage = result.usage;
          return {
            content: [{ type: "text", text: buildSearchContent(result, params.query) }],
            details: {
              query: params.query,
              actions: result.actions,
              sources: result.sources,
              model: result.model,
            },
            usage: usage ? toPiUsage(usage) : undefined,
          };
        } catch (error) {
          if (isAbort(error)) {
            return {
              content: [{ type: "text", text: "The web search was cancelled." }],
              details: { query: params.query, cancelled: true },
            };
          }
          throw error;
        }
      },
    });
  }

  /** Resolve a DeepSeek API key: config -> env -> pi's deepseek provider auth. */
  async function resolveSearchApiKey(ctx: ExtensionContext): Promise<string | undefined> {
    const fromConfig = loadConfig(ctx.cwd).apiKey;
    if (fromConfig) return fromConfig;
    try {
      const fromProvider = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
      if (fromProvider) return fromProvider;
    } catch {
      // deepseek provider may not be configured
    }
    try {
      const auth = await ctx.modelRegistry.getProviderAuth("deepseek");
      return auth?.auth?.apiKey;
    } catch {
      return undefined;
    }
  }

  /** Make sure a `web_search` tool exists before enabling plan mode. */
  function ensureSearchTool(): void {
    if (searchToolRegisteredByUs) return;
    const hasWebSearch = pi.getAllTools().some((t) => t.name === "web_search");
    if (!hasWebSearch) {
      registerSearchTool();
      searchToolRegisteredByUs = true;
      captureOwnToolSource("web_search");
    }
  }

  pi.registerTool({
    name: "plan_clear",
    label: "Reset Plan (asks user)",
    description:
      "Reset this session's plan file to a fresh template for an entirely new task. Always shows the user a confirmation dialog first and only resets if the user confirms. Use ONLY when the user's request starts a brand-new task unrelated to the current plan.",
    promptSnippet: "Reset the plan file for an entirely new task (asks the user to confirm)",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Why the plan should be reset" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ok = await ctx.ui.confirm(
        "Reset plan?",
        "Your session's plan file will be replaced with a fresh template. Continue?",
      );
      if (!ok) {
        return {
          content: [{ type: "text", text: "Plan reset cancelled — the user declined." }],
          details: { confirmed: false },
        };
      }
      const planFile = ensurePlanFile(ctx.cwd);
      writeFileSync(planFile, PLAN_TEMPLATE, "utf8");
      if (planModeEnabled) refreshPlanWidget(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Plan file reset to a fresh template (${planFile})${params.reason ? ` — reason: ${params.reason}` : ""}.`,
          },
        ],
        details: { confirmed: true, cleared: true },
      };
    },
  });

  /* ---------------------------------------------------------------- */
  /* Gates: enforce plan mode restrictions at the tool_call boundary   */
  /* ---------------------------------------------------------------- */

  pi.on("tool_call", async (event, ctx) => {
    if (!planModeEnabled) return;
    const label = modeLabel();

    // Provenance: name -> sourceInfo.source. Rebuilt on every call so
    // dynamically registered tools are seen. ToolCallEvent does not expose
    // sourceInfo, so the getAllTools() map is the source of truth.
    const sourceByName = new Map(pi.getAllTools().map((t) => [t.name, t.sourceInfo?.source]));
    const source = sourceByName.get(event.toolName);

    // Profile tool names (expanded from the active profile), used below to
    // decide whether a same-named non-builtin tool was explicitly allowed.
    const profileToolNames = new Set<string>();
    if (activeProfile?.tools) {
      const available = new Set(pi.getAllTools().map((t) => t.name));
      for (const entry of activeProfile.tools) {
        for (const m of expandToolEntry(entry, available)) profileToolNames.add(m);
      }
    }

    // Catch-all: only plan-mode tools may be called (defense-in-depth for
    // resumed sessions or models that somehow reference inactive tools).
    if (!new Set(planModeTools()).has(event.toolName)) {
      return {
        block: true,
        reason:
          `[${label}] Tool "${event.toolName}" is not available in plan mode. ` +
          `Only read/grep/find/ls, web_search, read-only bash${activeProfile ? ", and profile tools" : ""}, and edits to the plan file are allowed.\n` +
          `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`,
      };
    }

    // Deep behavior gates are provenance-aware: they only apply to the real
    // builtin tools. A lookalike extension tool sharing a base tool name
    // (bash/edit/write) must not inherit the builtin's validation; it is
    // blocked unless the active profile explicitly allowlisted that name.
    if (event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write") {
      if (source !== "builtin") {
        if (!profileToolNames.has(event.toolName)) {
          return {
            block: true,
            reason:
              `[${label}] Tool "${event.toolName}" is not the built-in ${event.toolName} tool and is not available in plan mode.\n` +
              `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`,
          };
        }
        return; // explicitly allowlisted profile tool — no deep gate applies
      }
    }

    // plan_clear is registered by this extension; only our own registration
    // is trusted under this name (a lookalike plan_clear is blocked). The
    // source is captured lazily here — getAllTools() is not callable during
    // extension loading, so load-time capture is impossible.
    if (event.toolName === "plan_clear") {
      if (!ownToolSources.has("plan_clear")) captureOwnToolSource("plan_clear");
      const own = ownToolSources.get("plan_clear");
      if (own !== undefined && source !== own) {
        return {
          block: true,
          reason:
            `[${label}] Tool "plan_clear" is not the plan-mode plan_clear tool and is not available in plan mode.\n` +
            `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`,
        };
      }
    }
    // web_search is exempt: it may be self-registered or provided by another
    // extension (e.g. pi-deepseek-search), both of which are legitimate.

    if (isToolCallEventType("bash", event)) {
      if (!isSafeCommand(event.input.command, activeProfile?.bash)) {
        return {
          block: true,
          reason:
            `[${label}] Command blocked — plan mode only allows read-only commands (and profile-approved commands).\n` +
            `Blocked: ${event.input.command}\n` +
            `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`,
        };
      }
      return;
    }

    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const rawPath = String(event.input.path ?? "");
      const planFile = getPlanFilePath(ctx.cwd, loadConfig(ctx.cwd));
      if (!isAllowedWritePath(ctx.cwd, planFile, activeProfile?.writePaths, rawPath)) {
        return {
          block: true,
          reason:
            `[${label}] Writes are restricted to the plan file (${planFile})${activeProfile?.writePaths ? ` and profile writePaths` : ""} in plan mode.\n` +
            `Blocked: ${rawPath}\n` +
            `Run /plan to leave plan mode, or /plan go to execute the plan with full access.`,
        };
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* Context management                                                */
  /* ---------------------------------------------------------------- */

  // Strip stale plan-mode instructions from LLM context when not in plan mode.
  pi.on("context", async (event) => {
    if (planModeEnabled) return;
    const filtered = event.messages.filter((m) => {
      const msg = m as { customType?: string; content?: unknown };
      if (msg.customType === CONTEXT_CUSTOM_TYPE) return false;
      if (m.role === "user" && typeof msg.content === "string" && msg.content.includes("[PLAN MODE ACTIVE]")) {
        return false;
      }
      return true;
    });
    if (filtered.length !== event.messages.length) return { messages: filtered };
  });

  // Inject plan-mode instructions at the start of every planning turn.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!planModeEnabled) return;
    const planFile = getPlanFilePath(ctx.cwd, loadConfig(ctx.cwd));
    return {
      message: {
        customType: CONTEXT_CUSTOM_TYPE,
        content: [
          "[PLAN MODE ACTIVE]",
          "You are in PLAN MODE: you research and write a plan; you do NOT implement anything.",
          "",
          `Plan file: ${planFile} — the source of truth. The UI shows a compact preview live; ${TOGGLE_KEY} opens the full plan in an editor (view/scroll/edit).`,
          ...(activeProfileName
            ? [`Profile: ${activeProfileName}${activeProfile?.description ? ` — ${activeProfile.description}` : ""}. Its extra tools, bash commands, and write paths are allowed in addition to the defaults.`]
            : []),
          "",
          "Available tools:",
          "- read, grep, find, ls — explore the codebase",
          "- web_search — DeepSeek-backed web search for external/up-to-date information",
          "- bash — ONLY read-only allowlisted commands (never write, delete, push, or touch the network)",
          "- edit, write — ONLY on the plan file",
          "- plan_clear — reset the plan for a brand-new task (asks the user to confirm)",
          "",
          "Working loop, per user message:",
          "1. First, tell the user in ONE short line what you are updating in the plan and why.",
          "2. Read the plan file, then update it with edit/write (only the plan file may be written).",
          "3. Reply with a brief summary of the change and what is still open.",
          "",
          "Guidelines:",
          "- Keep the plan actionable: goal, constraints/context, concrete steps.",
          "- Structure the plan with concrete checklist steps (- [ ]): at execution time (/plan go) each step becomes a todo that tracks progress.",
          "- Research first (read files, web_search), then write.",
          "- If the user's request clearly starts an ENTIRELY NEW task unrelated to the current plan, call plan_clear (it asks the user to confirm) instead of editing the existing plan in place.",
          "- If the user asks you to do real work, remind them to run /plan go to execute the plan.",
        ].join("\n"),
        display: false,
      },
    };
  });

  /* ---------------------------------------------------------------- */
  /* Turn lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  // Refresh the plan widget after each agent run so it reflects the file.
  pi.on("agent_end", async (_event, ctx) => {
    if (!planModeEnabled) return;
    refreshPlanWidget(ctx);
  });

  /* ---------------------------------------------------------------- */
  /* Session lifecycle                                                 */
  /* ---------------------------------------------------------------- */

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    const last = [...entries]
      .reverse()
      .find(
        (e) =>
          (e as { type?: string }).type === "custom" &&
          (e as { customType?: string }).customType === STATE_CUSTOM_TYPE,
      ) as { data?: PlanModeState } | undefined;
    if (last?.data) {
      planModeEnabled = last.data.enabled ?? false;
      toolsBeforePlanMode = last.data.toolsBeforePlanMode;
      activeProfileName = last.data.profile;
    }

    // Startup flags: --plan (boolean, plain plan mode) and
    // --plan-profile <name> (plan mode with a profile).
    if (pi.getFlag("plan") === true) planModeEnabled = true;
    const profileFlag = pi.getFlag("plan-profile");
    if (typeof profileFlag === "string" && profileFlag !== "") {
      planModeEnabled = true;
      activeProfileName = profileFlag;
    }

    if (planModeEnabled) {
      const { canonicalName, profile } = resolveProfile(ctx, activeProfileName);
      if (activeProfileName && !profile) {
        ctx.ui.notify(
          `[plan mode] Unknown profile "${activeProfileName}" — starting plan mode without a profile.`,
          "warning",
        );
      }
      activeProfileName = canonicalName;
      activeProfile = profile;
      warnUnknownProfileTools(ctx, canonicalName, profile);
      ensureSearchTool();
      if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
      pi.setActiveTools(planModeTools());
      ensurePlanFile(ctx.cwd);
      updateStatus(ctx);
      refreshPlanWidget(ctx);
    }
  });
}
