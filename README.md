# pi-plan-ng — Plan Next Generation for pi

pi-plan-ng turns pi into a focused **planning loop**: instead of implementing
on the first prompt, the agent researches, drafts a plan in `PLAN.md`, and
refines it with you — then executes it on command with full tool access.

The plan lives in a markdown file you can read, scroll, and edit in a
**full-screen viewer** with rendered formatting. And because every planning
session has different needs, pi-plan-ng is **extensible by design**: profiles
let you open the door for extra bash commands (say, `julia`), extra tools
(say, MCP servers like Kaimon), and extra writable paths — while everything
else stays locked down. A configurable `reasoningEffort` sets how much
thinking the planner puts into each turn.

## Features

**Full-screen plan viewer — rendered markdown, in-place editing.**

- `Alt+O` (or `/plan open`) opens the plan in a full-screen viewer:
  headings, lists, task checkboxes, code blocks, tables, and links rendered
  as formatted markdown, wrapped to your terminal width.
- **Last round's edits are highlighted by default**: opening the plan after
  a planning turn shows the whole plan with additions in **green** and
  removals in **red** (with strikethrough) right where they occur — single-line
  edits are merged inline, and the title shows a `+N −M` summary. There are no
  `+`/`-` gutter markers, so copy-paste of the plan stays clean. When there was
  no change in the last round, the plan renders normally.
- Scroll with `↑`/`↓`, `ctrl+PageUp`/`ctrl+PageDown`, or `g`/`G` for
  top/bottom.
- Press `e` to switch to the full plan editor — it opens at the top of the
  plan. `Shift+Enter` adds a newline, `Enter` saves back to the plan file
  and returns to the rendered view, `Esc` closes without saving.
- The viewer works whether or not plan mode is on, and the one-line status
  widget above the input box (`📋 Plan <file> · N lines · Alt+O to view`)
  refreshes after every change.

**Extensible: profiles open the door for your tools.**

- A **profile** extends plan mode's allowlist: extra tools (exact names or
  `kaimon*` globs for MCP servers), extra bare bash commands (e.g.
  `julia`), and extra writable paths.
- Enter with `/plan julia`, switch profiles while planning, or start pi
  already in profile mode with `pi --plan-profile <name>`.
- Everything not explicitly granted by the active profile stays blocked.

**Configurable thinking effort.**

- `"reasoningEffort"` sets the thinking level for planning turns
  (`off | minimal | low | medium | high | xhigh | max`), applied when plan
  mode turns on and restored to your previous level when it turns off.

**Execute the plan when it's ready.**

`/plan go` hands the plan to the agent with full tool access — each
checklist step becomes a tracked **todo**. See
[Executing the plan](#executing-the-plan).

## Install

```bash
pi install https://github.com/csvance/pi-plan-ng
# pin a version with a tag: pi install https://github.com/csvance/pi-plan-ng@v0.1.0
```

Requires Node ≥ 18. Or point pi at a local checkout (live reference — edits
apply on `/reload`):

```bash
pi install /home/csvance/Git/pi-plan-ng -l
```

Or copy the directory into a project's `.pi/extensions/` for offline use.
Restart pi or run `/reload` after installing.

One dependency: `/plan go` tracks execution with the `todo` tool from
[`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo).

```bash
pi install @juicesharp/rpiv-todo
```

## Usage

| Action | Command / key |
| ------ | ------------- |
| Enter / exit plan mode | `/plan` (toggles) |
| Plan mode with a profile (e.g. julia) | `/plan julia` |
| Open the plan in the full-screen viewer (`e` toggles editing) | `Alt+O` or `/plan open` |
| Execute the plan (exit plan mode + full tools) | `/plan go` |
| Pick this session's plan file (e.g. `PLAN2.md`) | `/plan file PLAN2.md` |
| Reset the plan file to the default | `/plan file` |
| Reset the plan file (asks for confirmation) | `/plan clear` |
| Show state (mode, profile, effort, todos) | `/plan status` |
| Start pi already in plan mode | `pi --plan`, `pi --plan-profile <name>`, or `pi --plan-file <name>` |

### The loop

While plan mode is on, each message runs the same loop:

1. The agent tells you — in one short line — what it is updating in the plan
   and why.
2. It updates the plan file (the only writable file).
3. It replies with a brief summary of the change.

The plan file is **never deleted** on exit or re-entry — it is only replaced
by an explicit, confirmed reset (`/plan clear` or the agent's `plan_clear`
tool). If a request clearly starts a brand-new task, the agent calls
`plan_clear` to reset the plan (with your confirmation).

## Configuration

The config lives in `~/.pi/agent/plan-mode.json` (global) or
`.pi/plan-mode.json` (project; merges over global, later fields/arrays
win). Copy the example from `plan-mode.config.example.json`. Everything is
optional:

```json
{
  "reasoningEffort": "low",
  "planFile": "PLAN.md",
  "profiles": {
    "julia": {
      "description": "Planning with Julia script execution",
      "bash": ["julia"]
    },
    "dev": {
      "description": "Planning with MCP tool access (e.g. Kaimon)",
      "tools": ["kaimon*"]
    }
  }
}
```

- **`reasoningEffort`** — thinking level for planning turns:
  `off | minimal | low | medium | high | xhigh | max`. Clamped to the
  current model's capabilities; restored on exit.
- **`planFile`** — plan file path, relative to the project root. Default:
  `PLAN.md` (created with a template on first entry).
- **`profiles`** — named allowlist extensions, see below.

### Multiple plan files

By default every plan-mode session reads and writes `PLAN.md`. To let
several agents plan in parallel **in the same repo** without stepping on
each other, give each session its own plan file:

- `/plan file PLAN2.md` — this session now reads/writes `PLAN2.md`
  instead of `PLAN.md`. The widget, `/plan go`, `/plan open`, the
  edit/write gate, `plan_clear`, and the agent's instructions all target
  the chosen file.
- `/plan file` (no operand) — reset back to the default (`PLAN.md`, or
  the config `planFile`).
- `pi --plan-file PLAN2.md` — start plan mode directly on a named file.

The choice is **per process**, so two agents in the same repo are
naturally isolated: agent A runs `/plan file A.md`, agent B runs
`/plan file B.md`, and neither can write the other's file. The selected
file persists across plan-mode toggles and session restarts until you
change or reset it.

The plan file must resolve **inside the project** (absolute paths or
`..`/symlink escapes are rejected with a warning), so selecting a file can
never widen plan mode's write scope beyond the repo.

### Profiles

Profiles extend plan mode's allowlist for specific workflows. They **merge
by name** (global → project; later fields/arrays win), so a project can
extend or override a global profile. Extending the `julia` profile from
above with a writable notebook directory:

```json
{
  "profiles": {
    "julia": { "writePaths": ["notebooks/"] }
  }
}
```

- **`tools`** — extra tool names (MCP or extension tools). Exact names or
  `*`-suffix globs: `kaimon*` allows every available tool starting with
  `kaimon`. Unknown entries warn and are ignored.
- **`bash`** — extra bare command names through the bash gate, composable
  with `|` and `&&` like the defaults (`cd src && julia test/runtests.jl |
  tail -30`).
- **`writePaths`** — directories where `edit`/`write` are allowed besides
  the plan file (relative to the project root).

`/plan <name>` enters plan mode with that profile (or switches to it if
already planning); built-in subcommands (`go`, `clear`, `status`, `open`)
take precedence over profile names.

> **Security:** profiles deliberately relax plan-mode guarantees — a
> profile bash command like `julia` is arbitrary execution. Treat profiles
> as trusted, user-authored config.

## Plan-mode restrictions

While planning, only these tools are active: `read`, `grep`, `find`, `ls`
(explore), `bash` (read-only allowlist), `edit`/`write` (plan file only),
`plan_clear`, and — when pi or another extension provides one —
`web_search`. Profiles add their tools and commands on top.

The **bash gate** only allows bare, read-only commands (`ls`, `grep`,
`git status`/`log`/`diff`, …) and rejects anything that writes, executes
other commands, or touches the network (`rm`, `sed`, `xargs`, `curl`,
`ssh`, `sudo`, `git push`, …). Safe composition (`|`, `&&`) is allowed,
and the write gate canonicalizes paths so symlinks cannot redirect a write
outside the allowed set. The agent sees the exact allowlist and deny rules
in its context each turn — and the gate enforces them regardless.

When a command is denied, the gate's `block.reason` tells the agent
**exactly why** — the offending token (`sort -o`, `;`, `rm`, `git push`,
…), the rule it violates, and what to change (e.g. the allowed read-only
git subcommands, or noting the action in the plan for `/plan go`) — so
the next attempt is more likely to be legal. The explanation comes from
the same code that decides allow/deny (`checkSafeCommand` in `utils.ts`),
never a parallel re-implementation, so it cannot drift from enforcement.

## Executing the plan

`/plan go` exits plan mode and hands the plan to the agent with full tool
access. Execution is tracked with the `todo` tool
([`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)):

- Each checklist step (`- [ ]`) becomes a todo; plans without a checklist
  are broken into logical steps.
- Re-running a plan reuses the existing plan todos (marked
  `metadata.tags: ["plan"]`) instead of duplicating them.
- The plan file is left untouched — todos are the source of truth for
  progress. Check them anytime with `/todos`.

`/plan go` also works while plan mode is off. It refuses to start if the
todos extension is missing.

## Web search

pi-plan-ng doesn't bundle a search tool and needs no search configuration.
When pi or another extension provides a `web_search` tool, it stays
available in plan mode; otherwise the tool list simply omits it. Run
`/plan status` to see what's available.

## Development

```bash
npm install        # dev dependencies
npm run typecheck  # tsc --noEmit (strict)
npm test           # node:test — utils incl. the bash-allowlist security gate
```

See [`AUDIT.md`](./AUDIT.md) for the security review of the command gate
and [`WORKFLOWS.md`](./WORKFLOWS.md) for multi-agent workflow guidance.

## Credits

A ground-up rewrite of the official
[`plan-mode` example](https://github.com/earendil-works/pi-mono/tree/main/examples/extensions/plan-mode)
from [pi-mono](https://github.com/earendil-works/pi-mono): a file-based
`PLAN.md` workflow, a full-screen rendered plan viewer with in-place
editing, profiles for extensibility, configurable thinking effort, and
`/plan go` execution tracked with todos. MIT licensed.
