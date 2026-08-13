# Plan Mode (v2) — a Claude Code-style planning extension for pi

`/plan` puts pi into a restricted **planning loop**: the agent researches
(read files, DeepSeek-backed web search, read-only bash), states what it is
about to update, and maintains a plan in a markdown file. A compact preview
of the plan is shown live above the input box; **`Alt+O`** opens the full
plan in a full-screen editor so you can scroll through, read, and edit the
entire thing. `/plan go` hands the plan to the agent with full tool access
to execute it. Execution progress is tracked with **todos** (the `todo`
tool from `pi-agent-extensions`): each checklist step in the plan becomes
a todo, and the plan file itself is left untouched while executing.

`/plan <profile>` enters plan mode with a user-defined **profile** that
extends the restricted allowlist — extra tools (e.g. MCP tools), extra
bash commands (e.g. `julia`), and extra writable paths. See
[Profiles](#profiles).

The plan file is **never deleted** when you exit or re-enter plan mode. It
is only replaced by an explicit, user-confirmed reset (`/plan clear` or the
agent's `plan_clear` tool).

## Install

### From GitHub (recommended for everyone else)

```bash
pi install https://github.com/<your-username>/pi-plan-ng
# pin a version with a tag:
pi install https://github.com/<your-username>/pi-plan-ng@v0.1.0
```

Installs to `~/.pi/agent/git/` (a real clone; `@ref` pins are respected and
reconciled by `pi update --extensions`). Restart pi or run `/reload`.

### From the local git repo (the author's dev machine)

If you keep a checkout of this repo on disk (e.g.
`/home/csvance/Git/pi-plan-mode`), you can point pi at it directly:

```bash
# global (all projects)
pi install /home/csvance/Git/pi-plan-mode
# project-local (settings go in this project's .pi/)
pi install /home/csvance/Git/pi-plan-mode -l
```

A local path is a **live reference, not a copy** — pi loads the extension
straight from that directory. To update, just update the repo and reload:

```bash
git -C /home/csvance/Git/pi-plan-mode pull
# then /reload in pi (or restart) — no re-install needed
```

`pi update` does nothing for local paths (nothing is fetched or copied), so
this workflow is `git pull` + `/reload`. To remove the local install:

```bash
pi remove /home/csvance/Git/pi-plan-mode [-l]
```

Caveats:

- Don't also copy the repo into the same project's `.pi/extensions/` —
  installing the local path *and* auto-discovering a copy would register
  `plan`, `Alt+O`, `web_search`, and `plan_clear` twice. Pick one way per
  project (install for shared dev; copy for throwaway experiments).
- Keep the folder path stable; a local install breaks if the directory moves.
- Prefer the GitHub install for other machines/people: it is a copy with
  pinned refs, updated via `pi update --extensions`.

| Install source | Copy or live? | Update command | Best for |
| -------------- | ------------- | -------------- | -------- |
| GitHub URL | Copy (clone, pinned) | `pi update --extensions` | everyone else, pinned releases |
| Local path | Live reference | `git pull` + `/reload` | the author, offline dev |

### Dependencies

Execution progress is tracked with the `todo` tool from
[`pi-agent-extensions`](https://pi.dev/packages/pi-agent-extensions)
(adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)).
Install it once:

```bash
pi install pi-agent-extensions
```

Unlike `web_search` (which has a built-in fallback), this is a **hard
dependency**: `/plan go` refuses to run without it, and `/plan status`
reports whether it is available.

### Manual copy (offline fallback)

Copy this directory into your project's `.pi/extensions/`:

```
.pi/extensions/plan-mode/
├── index.ts
├── utils.ts
├── package.json
├── plan-mode.config.example.json
└── README.md
```

The extension is auto-discovered from `.pi/extensions/` on the next start
(or `/reload`).

## Usage

| Action | Command / key |
| ------ | ------------- |
| Enter / exit plan mode | `/plan` (toggles) |
| Enter plan mode with a profile (e.g. julia) | `/plan julia` |
| Execute the plan (exit plan mode + full tools) | `/plan go` |
| Open the plan in a full-screen editor (view / scroll / edit) | `/plan open` or `Alt+O` |
| Reset the plan file (asks for confirmation) | `/plan clear` |
| Show state (mode, plan file, search config) | `/plan status` |
| Start pi already in plan mode | `pi --plan` or `pi --plan-profile <name>` |

### The loop

While plan mode is on, every message runs through the same loop:

1. The agent tells you — in one short line — what it is updating in the
   plan and why.
2. It updates the plan in the markdown file (only the plan file may be
   written; everything else is read-only).
3. It replies with a brief summary of the change.
4. The widget above the editor refreshes to show the updated plan.

The agent is instructed that if your request clearly starts an **entirely
new task** unrelated to the current plan, it should call `plan_clear` —
which shows a confirmation dialog before replacing the file.

## Tool restrictions in plan mode

Only these tools are active while planning:

- **`read`, `grep`, `find`, `ls`** — explore the codebase
- **`web_search`** — DeepSeek-backed web search (see below)
- **`bash`** — restricted to a read-only allowlist (see below)
- **`edit`, `write`** — allowed *only* on the plan file (enforced at the
  `tool_call` boundary)
- **`plan_clear`** — reset the plan for a new task (user confirmation)

Everything else is removed from the active tool set, and the gates block
any `bash`/`edit`/`write` call that violates the rules even if it slips
through.

The `todo` tool is intentionally **not** available in plan mode — tasks
are created from the plan's checklist steps when you run `/plan go`.

### Safe bash allowlist

Bash commands must start with a bare allowlisted command. **Read-only
composition is allowed**: pipelines (`grep -r foo . | head -20`) and `&&`
chains (`cd src && ls`) — every segment must independently pass the same
checks, so no non-allowlisted command can ever run. `;`, `||`, and
backgrounding (`&`) stay blocked, as do backticks, `$()`, `<`, `>`,
parens, and newlines. Quoted text is literal (`grep 'a|b' file`, `echo 'a
&& b'`, julia one-liners with `;` inside quotes) — except `$` and
backticks inside **double** quotes, where bash still expands them, so
those stay blocked (`echo "$(ls)"` is rejected). Allowed commands include:

```
ls cat head tail wc grep rg find tree file stat du df realpath readlink
basename dirname nl fold tac sort uniq cut tr comm join paste column od
hexdump xxd strings sha256sum md5sum jq yq bat less more diff cmp cd pwd
which whoami echo printf printenv date uptime uname id hostname ps type
git status|log|diff|show|ls-files|rev-parse|shortlog|blame|whatchanged|
describe|check-ignore|check-attr|count-objects|symbolic-ref|name-rev|
help|version|ls-tree|ls-remote|grep
```

`cd` only affects the current bash call (each call runs in a fresh
shell) — chain it with `&&` in the same command.

Deliberately excluded: anything that writes, executes other commands, or
touches the network (`rm`, `touch`, `mkdir`, `git push`, `git checkout`,
`awk`, `sed`, `xargs`, `env`, `curl`, `wget`, `ssh`, `sudo`, `find -exec`,
`find -delete`, …). If you need stronger isolation (OS-level filesystem and
network sandboxing via bubblewrap/sandbox-exec), pair this with the
[`sandbox` example extension](https://github.com/earendil-works/pi-mono/tree/main/examples/extensions/sandbox)
— plan mode's gates and the sandbox compose cleanly.

## Profiles

Profiles extend plan mode's allowlist for specific workflows. Define them
in the config — global `~/.pi/agent/plan-mode.json` or project
`.pi/plan-mode.json`; profiles **deep-merge by name** (global → project),
so a project can extend or override a global profile:

```json
{
  "profiles": {
    "julia": {
      "description": "Planning with Julia script execution",
      "tools": ["kaimon*"],
      "bash": ["julia"],
      "writePaths": ["notebooks/"]
    }
  }
}
```

- **`/plan <name>`** enters plan mode with that profile (or switches to it
  if plan mode is already on). Bare `/plan` keeps its toggle behavior
  (no profile). `/plan status` shows the active profile and lists
  available ones; argument completions include profile names.
  Built-in subcommands (`go`, `clear`, `status`, `open`) take precedence
  over profile names.
- **`tools`** — extra tool names allowed (MCP or extension tools). Exact
  names or `*`-suffix globs (`kaimon*` matches every available tool
  starting with `kaimon`). Unknown entries are warned about and ignored
  at activation.
- **`bash`** — extra bare command names allowed through the bash gate
  (e.g. `julia`), composable with `|` and `&&` like the defaults
  (`cd src && julia --project=. test/runtests.jl | tail -30`).
- **`writePaths`** — directories where `edit`/`write` are allowed in
  addition to the plan file (relative to the project root).
- **Startup:** `pi --plan-profile <name>` starts pi in plan mode with
  that profile.

> **Security note:** profiles deliberately relax plan-mode guarantees. A
> profile bash command (e.g. `julia`) is arbitrary execution — the
> process decides what it writes, not the gate. Treat profiles as
> trusted, user-authored config; everything not explicitly granted stays
> blocked.

## Web search

Plan mode includes a `web_search` tool. It **reuses an existing
`web_search` tool if one is registered** (e.g. the
[`pi-deepseek-search`](https://pi.dev/packages/pi-deepseek-search) package)
and only registers its own DeepSeek implementation as a fallback.

The built-in fallback calls DeepSeek's `/responses` API with the server-side
`web_search` tool and returns the synthesized answer plus citations.
Configuration (env → `~/.pi/agent/plan-mode.json` → `.pi/plan-mode.json`):

```json
{
  "apiKey": "sk-...",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "low",
  "searchTimeoutMs": 30000
}
```

`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL` environment
variables work too. If neither is set, the tool falls back to the API key
of pi's configured `deepseek` provider (`/login deepseek`). Run
`/plan status` to see whether search is configured.

## Plan file

- Default: `PLAN.md` in the project root. Override with `"planFile"` in the
  config (relative to the project root). Created automatically with a
  template the first time you enter plan mode.
- Persists across sessions and across `/plan` on/off toggles. It is never
  deleted implicitly.
- While executing (`/plan go`), the plan file is **not** edited — each
  checklist step becomes a todo (`.pi/todos/`) and progress is tracked
there instead.

## Execution tracking with todos

`/plan go` hands the plan to the agent with full tool access. Instead of
editing the plan file's checkboxes during execution, the agent tracks
progress with the `todo` tool (requires
[`pi-agent-extensions`](https://pi.dev/packages/pi-agent-extensions)):

1. On `/plan go`, the agent lists existing todos (`todo list-all`) and
   reuses the ones tagged `plan` from a previous run — updating titles of
   changed steps and deleting stale entries, so re-executing a plan does
   not duplicate tasks.
2. It creates one todo per checklist step (`- [ ]`) in the plan file —
   title = the step, body = relevant context from the plan, tag = `plan`.
   Plans without a checklist are broken into logical steps.
3. As it works, it claims each todo before starting, appends brief notes
   on what was done, and closes it when finished.
4. The plan file is left untouched — todos are the source of truth for
   step state. Check progress anytime with `/todos` (interactive list) or
   `todo list-all`.

If the todos extension is missing, `/plan go` shows a warning and does not
start execution.

## Display

A compact widget above the input box shows the plan preview:

- **Always ≤ 10 lines** — pi's TUI caps widget line arrays at 10, so the
  widget shows the plan title, the first `collapsedLines` lines (default 5,
  configurable via `"collapsedLines"` in the config), and a hint.
- **`Alt+O` / `/plan open`** opens the full plan in a full-screen editor:
  scroll through every line, edit, and save — changes are written back to
  the plan file and the widget refreshes. Cancelling (Esc) leaves the file
  untouched. This works whether or not plan mode is currently on.
- The footer shows `⏸ plan` while plan mode is on.

The widget and plan-mode state are persisted in the session
(`pi.appendEntry`), so they survive `/reload` and session resume.

## Development

```bash
npm install        # dev dependencies (typescript, types, pi types)
npm run typecheck  # tsc --noEmit (strict)
npm test           # node:test — utils incl. the bash-allowlist security gate
```

Note: the extension imports `./utils.ts` with the `.ts` extension (pi loads
TypeScript directly via jiti), so `tsconfig.json` uses
`allowImportingTsExtensions` + `noEmit`.

## Publishing to GitHub

The repo is already initialized (`main` branch, `v0.1.0` tag). To publish:

```bash
# 1. authenticate once
gh auth login

# 2. replace the <your-username> placeholders in this README and in
#    package.json (repository/bugs/homepage)

# 3. create the (public) repo and push
gh repo create pi-plan-ng --public --source=. --remote=origin --push

# 4. set metadata
gh repo edit --description "Claude Code-style plan mode for pi: PLAN.md workflow, DeepSeek web search, /plan go execution, full-screen plan view (Alt+O)" --add-topic pi-package
```

After that, anyone can install it with
`pi install https://github.com/<your-username>/pi-plan-ng`.

## Credits

A ground-up rewrite of the official
[`plan-mode` example](https://github.com/earendil-works/pi-mono/tree/main/examples/extensions/plan-mode)
from [pi-mono](https://github.com/earendil-works/pi-mono), with a
file-based `PLAN.md` workflow, DeepSeek-backed web search, `/plan go`
execution, and a full-screen plan view. MIT licensed.

## Notes

- `/plan go` also works while plan mode is already off: it reads the plan
  file and starts execution with full tool access.
- The stale "[PLAN MODE ACTIVE]" context is stripped from the LLM context
  whenever plan mode is off, so later turns are never confused by old
  planning instructions.
- `plan_clear` (tool) and `/plan clear` (command) both ask for explicit
  user confirmation before replacing the plan file.
- **Repository layout:** this is a standalone repo — the package root is
the repo root (`index.ts`, `utils.ts`, `package.json` at the top). It was
developed in a scratch project's `.pi/extensions/plan-mode/` (pi's
project-local auto-discovery location); to develop on it now, either clone
it back into a project's `.pi/extensions/` or use the local-path install
above in any project.
