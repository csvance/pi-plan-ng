/**
 * Plan mode — Claude Code-style planning for pi.
 *
 * `/plan` enters plan mode: the agent's tools are restricted to reading
 * files, read-only bash, and writing ONLY the plan file (plus whatever a
 * profile allows). Each turn the agent states what it's updating, updates
 * the plan in a markdown file (PLAN.md by default), and a one-line status
 * is shown in a widget above the editor. `Alt+O` opens the plan in a
 * full-screen viewer to read, scroll, and edit it; saving writes the
 * changes back to the plan file.
 *
 * `/plan go` exits plan mode and executes the plan with full tool access.
 * Execution progress is tracked with todos (the `todo` tool from
 * @juicesharp/rpiv-todo): each plan step becomes a todo marked with
 * metadata tags ["plan"], and the plan file itself is not edited while
 * executing.
 * `/plan <profile>` enters plan mode with a user-defined profile that
 * extends the allowlist (extra tools such as MCP tools, extra bash
 * commands, extra write paths) — see the "profiles" key in the plan-mode
 * config. This is the intended way to bring in more execution: e.g. a
 * `julia` bash command in a julia profile, or a `kaimon*` MCP tool set.
 * The config also accepts "reasoningEffort" to set the thinking level
 * used for planning turns (restored on exit).
 * `/plan file <name>` picks this session's plan file (default PLAN.md),
 * so multiple agents in the same repo can plan in parallel without
 * stepping on each other; `/plan file` with no name resets to the default.
 * The `--plan-file <name>` startup flag starts plan mode on a named file.
 * `/plan clear` resets the plan file (with confirmation).
 * The plan file is never deleted on exit/re-entry; only an explicit,
 * user-confirmed reset replaces it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  buildWidgetLines,
  buildPlanModeTools,
  bashBlockReason,
  describePlanModeBashRules,
  describeProfileGrants,
  expandToolEntry,
  getPlanFilePath,
  isAllowedWritePath,
  isSymlink,
  loadConfig,
  PLAN_TEMPLATE,
  resolvePlanFileIn,
  type PlanModeProfile,
} from "./utils.ts";
import { openPlanViewer } from "./plan-view.ts";

/** Plan-mode state and context entry types. */
const CONTEXT_CUSTOM_TYPE = "plan-mode-context";
const STATE_CUSTOM_TYPE = "plan-mode-state";

const TOGGLE_KEY = "Alt+O";

interface PlanModeState {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
  /** Active profile name (undefined = default, no profile). */
  profile?: string;
  /** Session-selected plan file, relative to cwd (undefined = default/config). */
  planFile?: string;
}

/** pi's thinking level union, derived from the extension API surface. */
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export default function (pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let toolsBeforePlanMode: string[] | undefined;
  let activeProfileName: string | undefined;
  let activeProfile: PlanModeProfile | undefined;
  /**
   * Session-selected plan file, relative to cwd. undefined = use the config
   * default (planFile / PLAN.md). Set via `/plan file <name>` or the
   * `--plan-file` flag; persists across plan-mode toggles and session
   * restarts until changed or reset via `/plan file`.
   */
  let activePlanFile: string | undefined;
  /** Thinking level captured on entry, restored when plan mode turns off. */
  let savedThinkingLevel: ThinkingLevel | undefined;
  /**
   * Plan content captured at the end of the previous planning round (in-memory
   * only). The viewer diffs this against the current file to highlight the last
   * round's edits. Set in `agent_end` after each round — so the FIRST round has
   * no baseline and is never highlighted; advanced past manual edits/clears so
   * they are not shown as agent changes.
   */
  let lastRoundBefore: string | undefined;
  /** sourceInfo.source of the tools THIS extension registers (plan_clear). */
  const ownToolSources = new Map<string, string>();

  /** Gate label used in block reasons and status, e.g. "plan mode (julia)". */
  function modeLabel(): string {
    return activeProfileName ? `plan mode (${activeProfileName})` : "plan mode";
  }

  /**
   * Tools available while plan mode is active. `web_search` is included
   * only when pi or another extension already provides it — plan mode no
   * longer bundles a search tool of its own.
   */
  function planModeTools(): string[] {
    const base = ["read", "grep", "find", "ls", "bash", "edit", "write", "plan_clear"];
    const available = new Set(pi.getAllTools().map((t) => t.name));
    if (available.has("web_search")) base.push("web_search");
    const { tools } = buildPlanModeTools(base, activeProfile, available);
    return tools;
  }

  function hasWebSearchTool(): boolean {
    return pi.getAllTools().some((t) => t.name === "web_search");
  }

  /**
   * True when the `todo` tool (@juicesharp/rpiv-todo) is available.
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

  pi.registerFlag("plan-file", {
    description: "Start in plan mode with the named plan file (relative to cwd)",
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
      planFile: activePlanFile,
    } satisfies PlanModeState);
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "plan-mode",
      planModeEnabled ? ctx.ui.theme.fg("warning", `⏸ plan${activeProfileName ? `·${activeProfileName}` : ""}`) : undefined,
    );
  }

  /**
   * The plan file for this session: the session-selected file when one is
   * set via `/plan file` or `--plan-file`, otherwise the config default
   * (config `planFile` / PLAN.md). Every plan-file concern routes through
   * here, so the widget, `/plan go`/`clear`/`open`/`status`, plan_clear,
   * the edit/write gate, and the injected prompt all target the same file.
   */
  function currentPlanFilePath(cwd: string): string {
    if (activePlanFile !== undefined) return resolve(cwd, activePlanFile);
    return getPlanFilePath(cwd, loadConfig(cwd));
  }

  /**
   * Ensure the plan file exists, creating the template if needed.
   * Synchronous on purpose: command/event handlers must not await across
   * a ctx lifetime (session replacement invalidates captured ctx
   * objects).
   */
  function ensurePlanFile(cwd: string): string {
    const planFile = currentPlanFilePath(cwd);
    mkdirSync(dirname(planFile), { recursive: true });
    // Never create the plan file through a symlink (dangling or live):
    // writeFileSync would follow it and clobber its target (AUDIT R6).
    if (!existsSync(planFile) && !isSymlink(planFile)) {
      writeFileSync(planFile, PLAN_TEMPLATE, "utf8");
    }
    return planFile;
  }

  function refreshPlanWidget(ctx: ExtensionContext): void {
    if (!planModeEnabled) return;
    const planFile = currentPlanFilePath(ctx.cwd);
    let content: string;
    try {
      content = readFileSync(planFile, "utf8");
    } catch {
      content = PLAN_TEMPLATE;
    }
    ctx.ui.setWidget(
      "plan-mode",
      buildWidgetLines(content, planFile, TOGGLE_KEY, ctx.ui.theme),
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
   * Apply the configured `reasoningEffort` as the session thinking level
   * while plan mode is on, remembering the previous level to restore.
   * pi clamps to the current model's capabilities, so unknown/unsupported
   * values degrade gracefully.
   */
  function applyThinkingEffort(ctx: ExtensionContext): void {
    if (savedThinkingLevel !== undefined) return; // already applied
    savedThinkingLevel = pi.getThinkingLevel();
    const effort = loadConfig(ctx.cwd).reasoningEffort;
    if (effort) pi.setThinkingLevel(effort);
  }

  /**
   * Enter plan mode, optionally with a named profile. Returns false (and
   * leaves plan mode off) when the profile is unknown. Warns about profile
   * tools that do not exist in the current tool set.
   */
  function enablePlanMode(ctx: ExtensionContext, profileName?: string): boolean {
    const { canonicalName, profile } = resolveProfile(ctx, profileName);
    if (profileName && !profile) return false;
    if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
    activeProfileName = canonicalName;
    activeProfile = profile;
    warnUnknownProfileTools(ctx, canonicalName, profile);
    pi.setActiveTools(planModeTools());
    planModeEnabled = true;
    applyThinkingEffort(ctx);
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
    if (savedThinkingLevel !== undefined) {
      pi.setThinkingLevel(savedThinkingLevel);
      savedThinkingLevel = undefined;
    }
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
      const todoOk = hasTodoTool();
      ctx.ui.notify(
        [
          `Plan mode on. Plan file: ${currentPlanFilePath(ctx.cwd)}`,
          todoOk
            ? "Execution will track progress with todos (rpiv-todo)."
            : 'WARNING: the todos extension is not installed (`pi install @juicesharp/rpiv-todo`) — /plan go will not run until it is.',
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
      "Toggle plan mode. Subcommands: go (execute plan), clear (reset plan), file <name> (pick this session's plan file), status, open. A profile name enters plan mode with that profile.",
    getArgumentCompletions: (prefix: string) => {
      const builtins = ["go", "clear", "status", "open", "file"];
      const profiles = Object.keys(loadConfig(process.cwd()).profiles ?? {});
      const out = [...builtins, ...profiles]
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a }));
      // While completing the operand of `/plan file <partial>`, offer
      // existing markdown files in the project root.
      const fileMatch = /^file\s+(.*)$/i.exec(prefix);
      if (fileMatch) {
        const partial = fileMatch[1];
        let md: string[] = [];
        try {
          md = readdirSync(process.cwd())
            .filter((f) => f.endsWith(".md") && f.startsWith(partial));
        } catch {
          /* cwd unreadable — no file suggestions */
        }
        for (const f of md) out.push({ value: f, label: f });
      }
      return out;
    },
    handler: async (args, ctx) => {
      // Split on whitespace so `file <name>` preserves the filename's case
      // (the first token is the subcommand; the rest is raw).
      const [head, ...rest] = (args ?? "").trim().split(/\s+/);
      const action = head.toLowerCase();

      if (action === "go") {
        if (!hasTodoTool()) {
          ctx.ui.notify(
            'Execution tracks progress with todos, but the todos extension is not installed. Install it with `pi install @juicesharp/rpiv-todo`, then /reload.',
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
            customType: "plan-execute",
            content: [
              "[EXECUTING PLAN]",
              "Full tool access has been restored. Execute the plan below, working through it step by step.",
              "",
              `Plan file: ${planFile} — the source of truth for WHAT to do.`,
              "",
              "TRACKING PROGRESS WITH TODOS:",
              '- Call todo {action:"list", includeDeleted:true} first to see which todos already exist.',
              '- If this plan was executed before, reuse the plan todos (marker: metadata.tags includes "plan") that still match plan steps: update subject/status of changed steps (todo update) and delete stale ones (todo delete).',
              '- Otherwise create one todo per step: todo {action:"create", subject:<step text>, description:<relevant plan context>, metadata:{tags:["plan"]}}.',
              "- Steps are the checklist items (- [ ]) in the plan file; if the plan has no checklist, break it into logical steps yourself.",
              "- Mark a todo in_progress with an activeForm BEFORE starting it; mark it completed IMMEDIATELY when done — never batch completions. Record brief notes on what was done by rewriting the todo's description (todo get first if you need the current text).",
              "- Do NOT edit the plan file while executing — todos are the source of truth for step state.",
              "",
              "--- PLAN ---",
              content.trim(),
              "--- END PLAN ---",
              "",
              "Start with the first step. When all todos are completed, summarize what was done.",
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
        if (isSymlink(planFile)) {
          ctx.ui.notify(`Refusing to reset: ${planFile} is a symlink.`, "error");
          return;
        }
        writeFileSync(planFile, PLAN_TEMPLATE, "utf8");
        // A reset is not an agent round: advance the baseline so no stale
        // "last round" diff is shown for the fresh template.
        lastRoundBefore = PLAN_TEMPLATE;
        if (planModeEnabled) refreshPlanWidget(ctx);
        ctx.ui.notify(`Plan reset: ${planFile}`, "info");
        return;
      }

      if (action === "status") {
        const config = loadConfig(ctx.cwd);
        const planFile = currentPlanFilePath(ctx.cwd);
        const profileNames = Object.keys(config.profiles ?? {});
        const activeDesc = activeProfile?.description ? ` — ${activeProfile.description}` : "";
        const activeGrants = activeProfile ? describeProfileGrants(activeProfile) : [];
        const customFile = activePlanFile !== undefined;
        ctx.ui.notify(
          [
            `Plan mode: ${planModeEnabled ? "ON" : "OFF"}`,
            `Profile: ${activeProfileName ?? "none (default)"}${activeDesc}`,
            ...(activeGrants.length ? [`Grants: ${activeGrants.join("; ")}`] : []),
            `Available profiles: ${profileNames.length > 0 ? profileNames.join(", ") : "(none)"}`,
            `Plan file: ${planFile}${customFile ? " (custom — /plan file to reset to default)" : ""}`,
            `Web search: ${hasWebSearchTool() ? "available (from pi or another extension)" : "not available (no web_search tool installed)"}`,
            `Thinking effort: ${config.reasoningEffort ?? "default (no override)"}`,
            `Todos: ${hasTodoTool() ? "available (rpiv-todo)" : "NOT installed — /plan go is disabled (`pi install @juicesharp/rpiv-todo`)"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (action === "open") {
        await openPlanView(ctx);
        return;
      }

      // Pick (or reset) this session's plan file. Works whether or not plan
      // mode is on, so an agent can choose its file before entering plan
      // mode. `/plan file` with no operand resets to the default.
      if (action === "file") {
        const name = rest.join(" ").trim();
        if (name === "") {
          activePlanFile = undefined;
          // Switching files invalidates the prior round's baseline.
          lastRoundBefore = undefined;
          ctx.ui.notify("Plan file reset to default.", "info");
          if (planModeEnabled) refreshPlanWidget(ctx);
          return;
        }
        const resolved = resolvePlanFileIn(ctx.cwd, name);
        if (!resolved) {
          ctx.ui.notify(
            `Plan file "${name}" must resolve inside the project.`,
            "warning",
          );
          return;
        }
        activePlanFile = name;
        // New file, no prior round baseline yet.
        lastRoundBefore = undefined;
        ctx.ui.notify(`Plan file set to ${name} (${resolved}).`, "info");
        if (planModeEnabled) refreshPlanWidget(ctx);
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
        // Show the actual grants, not just the (attacker-authored) description
        // (AUDIT R9).
        const grants = describeProfileGrants(profile);
        ctx.ui.notify(
          [
            wasOn
              ? `Switched to profile "${canonicalName}" (${profile.description ?? "no description"}).`
              : `Plan mode on with profile "${canonicalName}" (${profile.description ?? "no description"}).`,
            ...(grants.length ? [`Grants: ${grants.join("; ")}`] : []),
          ].join("\n"),
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
   * Open the plan in the full-screen viewer: by default the last round's
   * edits are highlighted (additions green, removals red/strikethrough); with
   * no prior round's change it shows the rendered markdown. `e` toggles into
   * the editor (Enter saves, Esc cancels — same semantics as the old
   * plain-editor view). Works whether or not plan mode is on.
   */
  async function openPlanView(ctx: ExtensionContext): Promise<void> {
    const planFile = ensurePlanFile(ctx.cwd);
    await openPlanViewer(ctx, planFile, lastRoundBefore, (text) => {
      // A manual viewer save is not an agent round: advance the baseline so
      // the manual edit is not shown as a "last round" change.
      lastRoundBefore = text;
      if (planModeEnabled) refreshPlanWidget(ctx);
      ctx.ui.notify("Plan updated.", "info");
    });
  }

  pi.registerShortcut("alt+o", {
    description: "Open plan in full-screen viewer (rendered markdown; e to edit)",
    handler: (ctx) => void openPlanView(ctx),
  });

  /* ---------------------------------------------------------------- */
  /* Tools                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Record the sourceInfo.source of a tool we just registered, so the gate
   * can tell our own plan_clear apart from lookalikes registered by other
   * extensions under the same name.
   */
  function captureOwnToolSource(name: string): void {
    const t = pi.getAllTools().find((x) => x.name === name);
    if (t?.sourceInfo?.source) ownToolSources.set(name, t.sourceInfo.source);
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
      if (isSymlink(planFile)) {
        return {
          content: [{ type: "text", text: `Refusing to reset: ${planFile} is a symlink.` }],
          details: { confirmed: false, cleared: false },
        };
      }
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
          `Only read/grep/find/ls${sourceByName.has("web_search") ? ", web_search" : ""}, read-only bash${activeProfile ? ", and profile tools" : ""}, and edits to the plan file are allowed.\n` +
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
    // web_search is exempt from the provenance check: it is provided by pi
    // or another extension and only enters the plan-mode tool set when it
    // actually exists.

    if (isToolCallEventType("bash", event)) {
      const reason = bashBlockReason(event.input.command, activeProfile?.bash, label);
      if (reason !== null) {
        return { block: true, reason };
      }
      return;
    }

    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const rawPath = String(event.input.path ?? "");
      const planFile = currentPlanFilePath(ctx.cwd);
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
    const planFile = currentPlanFilePath(ctx.cwd);
    return {
      message: {
        customType: CONTEXT_CUSTOM_TYPE,
        content: [
          "[PLAN MODE ACTIVE]",
          "You are in PLAN MODE: you research and write a plan; you do NOT implement anything.",
          "",
          `Plan file: ${planFile} — the source of truth. The UI shows a one-line plan status; ${TOGGLE_KEY} opens the full plan viewer (rendered markdown — scroll, and press e to edit).`,
          ...(activeProfileName
            ? [`Profile: ${activeProfileName}${activeProfile?.description ? ` — ${activeProfile.description}` : ""}. Its extra tools, bash commands, and write paths are allowed in addition to the defaults.`]
            : []),
          "",
          "Available tools:",
          "- read, grep, find, ls — explore the codebase",
          ...(hasWebSearchTool()
            ? ["- web_search — external/up-to-date information (provided by pi or another extension)"]
            : []),
          "- bash — read-only only; see BASH RULES below (enforced by the gate — a blocked command never runs)",
          "- edit, write — ONLY on the plan file",
          "- plan_clear — reset the plan for a brand-new task (asks the user to confirm)",
          "",
          "BASH RULES (read-only allowlist):",
          ...describePlanModeBashRules(activeProfile?.bash).split("\n"),
          "",
          "Working loop, per user message:",
          "1. First, tell the user in ONE short line what you are updating in the plan and why.",
          "2. Read the plan file, then update it with edit/write (only the plan file may be written).",
          "3. Reply with a brief summary of the change and what is still open.",
          "",
          "Guidelines:",
          "- Keep the plan actionable: goal, constraints/context, concrete steps.",
          "- Structure the plan with concrete checklist steps (- [ ]): at execution time (/plan go) each step becomes a todo that tracks progress.",
          "- Research first (read files" + (hasWebSearchTool() ? ", web_search" : "") + "), then write.",
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

  // Refresh the plan widget after each agent run so it reflects the file, and
  // capture the post-round content as the baseline for the NEXT round's diff.
  // (Baseline is set at agent_end — not before the first round — so the first
  // planning round is never highlighted as a diff.)
  pi.on("agent_end", async (_event, ctx) => {
    if (!planModeEnabled) return;
    const planFile = currentPlanFilePath(ctx.cwd);
    try {
      lastRoundBefore = readFileSync(planFile, "utf8");
    } catch {
      lastRoundBefore = PLAN_TEMPLATE;
    }
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
      // Restore the session-selected plan file, re-validated against the
      // current cwd (the repo/config may have changed since it was chosen).
      const restored = last.data.planFile;
      if (restored !== undefined && resolvePlanFileIn(ctx.cwd, restored) !== null) {
        activePlanFile = restored;
      } else if (restored !== undefined) {
        activePlanFile = undefined;
        ctx.ui.notify(
          `[plan mode] Plan file "${restored}" no longer resolves inside the project — using the default.`,
          "warning",
        );
      }
    }

    // Startup flags: --plan (boolean, plain plan mode),
    // --plan-profile <name> (plan mode with a profile), and
    // --plan-file <name> (plan mode on a named plan file).
    if (pi.getFlag("plan") === true) planModeEnabled = true;
    const profileFlag = pi.getFlag("plan-profile");
    if (typeof profileFlag === "string" && profileFlag !== "") {
      planModeEnabled = true;
      activeProfileName = profileFlag;
    }
    const fileFlag = pi.getFlag("plan-file");
    if (typeof fileFlag === "string" && fileFlag !== "") {
      planModeEnabled = true;
      if (resolvePlanFileIn(ctx.cwd, fileFlag) !== null) {
        activePlanFile = fileFlag;
      } else {
        ctx.ui.notify(
          `[plan mode] Plan file "${fileFlag}" must resolve inside the project — using the default.`,
          "warning",
        );
      }
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
      if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
      pi.setActiveTools(planModeTools());
      applyThinkingEffort(ctx);
      ensurePlanFile(ctx.cwd);
      updateStatus(ctx);
      refreshPlanWidget(ctx);
    }
  });
}
