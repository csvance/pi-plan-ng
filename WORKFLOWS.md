# Using Workflows Successfully

Practical guidance for orchestrating pi's multi-agent workflows
(`/workflow`, `pi-agent-extensions/extensions/workflow`), written from
real failures. The two rules that matter most:

1. **The script shape is a strict contract.** Get it wrong and you get
   `Unexpected token 'export'` before anything runs.
2. **Never assume agents return valid JSON.** They won't. Plan for
   repair and retry.

## Prevention, not just documentation

Three mechanisms make these failures structurally avoidable going forward:

1. **Saved workflow (runnable now):**

   ```bash
   /workflow saved recon-review '{"target": "utils.ts isSafeCommand", "focus": "…", "topN": 3}'
   ```

   A hardened recon → parallel hunters → synthesizer template with the
   tolerant JSON parser and correction pass built in. Source of truth:
   `examples/workflow-recon-review.js` in this repo (saved workflows are
   copies, so re-`cp` after edits: `cp examples/workflow-recon-review.js
   ~/.pi/workflows/saved/recon-review.js`).
2. **Skill (auto-loaded):** `~/.pi/agent/skills/workflow-orchestration/SKILL.md`
   — any session that dispatches workflows gets the contract, the JSON
   rules, tier guidance, and salvage instructions.
3. **This doc** — the full failure-mode table below.

---

## 1. The script contract (why "Unexpected token 'export'" happens)

`parseWorkflowScript` accepts exactly one shape:

```js
export const meta = {
  name: "…",                          // required, non-empty
  description: "…",                   // required, non-empty
  phases: [{ title: "Phase 1" }, …],  // optional
};

export default async function () {
  // ALL helper functions, constants, and orchestration live here.
  // Nothing else may exist at top level.
}
```

- The parser strips the `export const meta` statement and extracts the
  **body** of the single `export default function`. Any other top-level
  statement (a `const REPO = …`, a `function parseJson(){}`, a second
  export) survives into the evaluated body → syntax error. **Put
  everything inside the function.**
- Alternative shape: top-level code (helpers allowed) ending with a bare
  `run()` call; the trailing call is replaced with `return await run();`.
- The first statement must be `export const meta = {…}` — nothing before
  it (no comments above it is safest).

## 2. Agent output contracts (the "Unparseable agent output" failure)

Agents write prose, markdown fences, multi-line "repro" strings, and
regexes containing `\s` inside their JSON. A plain `JSON.parse` fails.
What we hit, in one run:

- literal newlines inside JSON strings (unescaped),
- invalid JSON escapes (`\s` from a regex in a fix suggestion),
- prose before the JSON ("All leads verified. Final JSON:") and missing
  closing fences.

**Mitigations, in order of importance:**

1. **Ask for compact JSON**: "Return STRICT JSON only, one line per
   field, no newlines inside strings, no markdown fences, no prose."
   Cheap, prevents most of it.
2. **Tolerant parser**: strip prose (first `{` → last `}`), repair
   literal `\n`/`\t`/`\r` inside strings, and double any invalid escape
   (`\X` → `\\X`). This recovered all 4 agent outputs from a failed run.
3. **Correction pass**: on parse failure, call the agent once more:
   "Your previous output was not valid JSON. Return ONLY valid JSON now."
   Don't let the whole workflow die on one bad string.
4. **Validate early with context**: if the recon agent's output doesn't
   parse, throw with the first 500 chars — the run file keeps everything
   anyway (see §4).

## 3. Orchestration patterns that work

- **recon → parallel hunters → synthesizer** (this repo's audit flow):
  one scout finds/ranks leads, `parallel()` fans out one agent per top
  lead (distribute the rest), a synthesizer merges. Pass each stage's
  output forward explicitly; keep it JSON.
- **Tiers are real model routes** (`~/.pi/workflows/model-tiers.json`):
  `scout` = flash:low, `worker` = flash:medium, `reviewer`/`synthesizer`
  = pro:high. Match the tier to the job — deep adversarial analysis on
  a `scout` tier is how you get shallow findings.
- **Unique labels, semantic tiers**: `agent(prompt, { label: "hunter-a",
  tier: "reviewer" })`. The label shows in the panel; the tier picks the
  model.
- **Set a token budget**: our 4 agents burned ~1.1M tokens (each agent
  makes many model round-trips with tool calls). Pass `tokenBudget` to
  the workflow tool when cost matters.
- **Return compact JSON** from the run function; it lands in the
  conversation automatically when the run finishes.

## 4. Progress, debugging, and salvage

| Symptom | Reality | What to do |
|---|---|---|
| Panel shows `0/1` agents for minutes | Healthy — 0 **done**, 1 **running**. Each agent turn is a model round-trip plus tool calls. | `/workflow status <runId>` for the deep view; check the owner PID's network connections (ESTAB to the API host = working) |
| "Unexpected token 'export'" | Script shape violation (§1) | Move helpers inside the default function; single top-level statement |
| "Unparseable agent output" | Agent JSON wasn't strict (§2) | Tolerant parser + correction pass; never crash the run on it |
| Run failed, but you needed the data | **The journal survives.** | `~/.pi/workflows/projects/<project>/runs/<runId>.json` — every agent's full output is in `journal[]`. Salvage with the tolerant parser and continue (we recovered all 8 findings this way) |
| Want to re-run just the last stage | — | Dispatch a small workflow whose only agent is the synthesizer, passing the salvaged outputs via `args` |

Commands: `/workflow` (hub), `/workflow active` (live runs),
`/workflow status <runId>` (agents/journal/evidence), `/workflow pause |
resume | stop | rm <runId>`, `/workflow doctor`, `/workflow setup`.

## 5. Failure-mode cheat sheet (from this repo's first workflow run)

| # | Error | Root cause | Fix |
|---|---|---|---|
| 1 | `Unexpected token 'export'` | Helpers/consts at top level alongside `export default` | Everything inside the run function |
| 2 | `Unparseable agent output: {"findings": …` | Literal newlines + invalid escapes (`\s`) in agent JSON | Tolerant repair parser (prose strip, escape repair) + compact-JSON prompt + correction pass |
| 3 | Synthesizer never ran, report lost | Same as #2 — parse failure aborted the run | Salvage `journal[]` from the run file; re-dispatch synthesis-only with salvaged data as `args` |
| 4 | Huge token counts on scout agents | Long prompts + many empirical tool calls per agent | Tight prompts, `tokenBudget`, limit repro loops in prompts |

**Lesson:** the workflow machinery itself was fine in every failure
above — the bugs were in the *orchestration script* (shape) and in
*assuming agent outputs were machine-parseable*. Both are preventable.
