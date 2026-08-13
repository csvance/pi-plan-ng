# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
