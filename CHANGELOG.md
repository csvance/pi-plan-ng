# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **One-line plan widget**: the compact preview is gone — the widget above
  the editor is now a single status line (`📋 Plan <path> · N lines ·
  Alt+O to view`). The `collapsedLines` config key is still parsed but no
  longer has any effect.
- **Full-screen plan viewer**: `Alt+O` / `/plan open` now opens a single
  full-screen viewer with two modes toggled in place with `e` — a
  **rendered markdown view** (formatted headings, lists, task checkboxes,
  code blocks, tables; scroll with `↑`/`↓`, `ctrl+PageUp`/`ctrl+PageDown`,
  `g`/`G`; plain PageUp/PageDown remain pi's transcript-scroll keys unless
  `tui.altScreen.*` is remapped) and the **edit mode** (also full-screen;
  Shift+Enter for newlines, `ctrl+PageUp`/`ctrl+PageDown` pages, Enter
  saves and returns to the rendered view, Esc cancels).

### Security

- **Command-gate hardening (closes `AUDIT.md` L1–L8)**:
  - `find` arguments are dequoted before dangerous-flag checks, so
    obfuscated forms (`find . '-delete'`, `find . "-exec" …`, `-\delete`,
    `-e'xec'`, brace expansion `-{d,d}elete`) are blocked; unquoted `{`/`}`
    are rejected in `find` commands (L1).
  - Write-capable flags on allowlisted commands are denied: `sort -o`/
    `--output` (incl. attached forms), `yq -i`/`--inplace`, `git
    diff/log --output=…` (L2, L7).
  - Unquoted word-initial `~` is rejected (L7); unquoted word-start `#`
    begins a comment mirroring bash, and commands ending in a lone
    unquoted backslash are rejected (L6, L8).
  - `git ls-remote` removed from the safe subcommands; URL/scp-style
    remote arguments to git are rejected (L4).
  - The write gate canonicalizes paths (realpath with
    deepest-existing-ancestor fallback), closing the symlink escape in
    `isAllowedWritePath` and the symlinked-`PLAN.md` variant (L3).
  - The `tool_call` gate is provenance-aware: `bash`/`edit`/`write` deep
    validation applies only to pi's builtin tools; a same-named tool from
    another extension is blocked unless a profile explicitly allows it;
    `plan_clear` must match our own registration; `*`-glob profile
    entries warn when they expand to multiple tools (L5).
  - New regression suites: `test/security-l1-l6-l8.test.ts`,
    `test/security-l2-l4.test.ts`, `test/security-l3-l5.test.ts`.

### Added

- **Profiles**: user-defined plan-mode profiles in the config (`profiles`
  in `plan-mode.json`, global → project deep-merge by name). `/plan
  <name>` enters/switches plan mode with a profile that extends the
  allowlist: extra tools (exact names or `*`-suffix globs, e.g. MCP
  tools), extra bare bash commands, and extra `writePaths` (edit/write
  directories besides the plan file). Unknown tools are warned about and
  ignored; unknown profiles are rejected with a list of available ones.
  `/plan status` shows the active profile; completions include profile
  names; `pi --plan-profile <name>` starts pi in plan mode with a
  profile; the active profile survives `/reload` and session resume and
  is shown in the footer status and gate messages.
- **Read-only bash composition**: pipelines (`grep -r foo . | head -20`)
  and `&&` chains (`cd src && ls`) are now allowed — every segment must
  independently pass the allowlist checks, so no non-allowlisted command
  can ever run. `;`, `||`, backgrounding `&`, and empty segments stay
  blocked; quoted pipes/operators are literal. `cd` joins the default
  safe command list.

### Changed

- `/plan go` now tracks execution progress with todos (the `todo` tool from
  [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo))
  instead of editing checkboxes in the plan file: on execution start the
  agent lists existing todos (`{action:"list", includeDeleted:true}`),
  creates one todo per plan step (marked with `metadata: {tags:["plan"]}`),
  reuses existing plan todos across runs (updating/deleting stale
  entries), marks each in_progress with an `activeForm` before starting,
  and marks it completed when done. The plan file is no longer edited
  during execution — todos are the source of truth for step state.
- Execution tracking now targets the `todo` tool from
  [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
  (install: `pi install @juicesharp/rpiv-todo`) instead of
  `pi-agent-extensions`: instructions and docs use the rpiv-todo
  action-based schema (`create`/`update`/`list`/`get`/`delete`/`clear`
  with `subject`/`description`/`activeForm`/`status`/`metadata`), the
  `plan` marker is `metadata.tags: ["plan"]` (metadata merges additively
  per key on update, so the marker survives later updates), the lifecycle
  is pending → in_progress (with `activeForm`) → completed, and progress
  notes are recorded by rewriting the task `description` — the previous
  extension's actions, statuses, and call shapes no longer apply.
- The todos extension is now a hard dependency: `/plan go` refuses to run
  without the `todo` tool, `/plan status` reports whether it is available,
  and entering plan mode warns when it is missing.

## [0.1.0] - 2026-08-13

Initial release of **Plan Mode (v2)** — a Claude Code-style planning extension
for pi. A rewrite of the official
[`earendil-works/pi-mono` example](https://github.com/earendil-works/pi-mono/tree/main/examples/extensions/plan-mode)
with a persistent `PLAN.md` workflow.

### Added

- `/plan` restricted planning loop: research with read-only tools, maintain the
  plan in `PLAN.md`, never delete it implicitly.
- `/plan go` execution (full tool access), `/plan clear` reset (user-confirmed),
  `/plan status`, `/plan open` (full-screen plan view/edit).
- Compact plan widget (≤ 10 lines — pi's TUI widget cap) with `Alt+O` opening
  the plan in a full-screen scrollable editor; edits write back to `PLAN.md`.
- DeepSeek-backed `web_search` tool (falls back to pi's `deepseek` provider
  key; reuses an existing `web_search` if another extension provides one).
- Read-only bash allowlist and plan-file-only write enforcement at the
  `tool_call` boundary.
- `plan_clear` tool that asks the user for confirmation before resetting.
- State persistence across `/reload` and session resume; stale plan-mode
  context stripped from the LLM context when plan mode is off.
