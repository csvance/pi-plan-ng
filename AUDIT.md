# AUDIT — Command Parsing Gate Security Review

**Date:** 2026-08-13
**Scope:** `utils.ts` (`isSafeCommand`, `splitComposition`, `isSafeSegment`,
`isAllowedWritePath`, `buildPlanModeTools`, allowlists) and the `tool_call`
gate in `index.ts`.
**Method:** Multi-agent adversarial review (recon agent → 3 hunter agents →
synthesis), with every finding **empirically verified** against the real
implementation (`node --experimental-strip-types`) and real bash, then
re-verified by a human auditor. All findings below reproduce on the
current code.

## Summary

| ID | Severity | Verdict | Title |
|----|----------|---------|-------|
| [L1](#l1-high) | **high** | real | `find` dangerous-flag bypass via quoting/backslash/brace obfuscation |
| [L2](#l2-high) | **high** | real | Allowlisted commands accept write flags → arbitrary file writes bypass the write-path gate |
| [L3](#l3-high) | **high** | real | `isAllowedWritePath` trusts lexical paths → symlink escapes the write allowlist |
| [L4](#l4-medium) | medium | real | `git ls-remote` performs network egress ("read-only" subcommand) |
| [L5](#l5-medium) | medium | real | Generic base tool names let other extensions' tools pass the gate unexamined |
| [L7](#l7-medium) | medium | real | Tilde expansion/globbing pass through; write-capable flags (overlaps L2) |
| [L6](#l6-low) | low | real | Unquoted `#` comment semantics mismatch (benign, but wrong) |
| [L8](#l8-low) | low | edge-case | Trailing backslash model incomplete but currently fail-safe |

**Bottom line:** plan mode's "read-only" guarantee is **broken in three
independent ways**, all reachable through the real gate: arbitrary file
writes (`sort -o`, `yq -i`, `git diff --output`), arbitrary command
execution / recursive deletion (`find . "-exec"` / `"-delete"`), and
write-allowlist escape via symlinks. None require shell metacharacter
smuggling — the failures are in argument validation and path
canonicalization, not the splitter.

---

## L1 — HIGH: `find` dangerous-flag bypass via quoting/backslash/brace obfuscation

**Verdict: real. Reproduces.**

The `find` branch of `isSafeSegment` splits on raw whitespace and tests
each word against `FIND_DANGEROUS` (`/^-?(exec|execdir|ok|okdir|delete|fprint|fprint0|fls|fprintf)/`).
Quote/backslash/brace characters prevent the anchored regex from matching,
but bash strips them before `find` sees argv:

```bash
node --experimental-strip-types -e "import {isSafeCommand} from './utils.ts'; console.log(isSafeCommand(\"find . '-delete'\"))"   # → true  (!!)
node --experimental-strip-types -e "import {isSafeCommand} from './utils.ts'; console.log(isSafeCommand('find . \"-exec\" rm -rf {} \\\\;'))"  # → true (!!)
```

Verified against real bash: `find . "-delete"` deleted files;
`find . "-exec" touch /tmp/pwned \;` created `/tmp/pwned`; `-{d,d}elete`
(brace expansion) also deletes; `"\ -delete"` etc. all execute. Plain
`find . -delete` is correctly blocked — only obfuscated forms leak.

**Root cause:** `utils.ts` find branch splits on `/\s+/` with no
shell-quote/escape awareness; `FIND_DANGEROUS` is anchored at word start.

**Exploit:** arbitrary command execution, recursive deletion, arbitrary
file writes (`-fprint`), all while plan mode claims read-only.

**Fix:** tokenize the find segment with the same quote/escape rules as
`splitComposition` (de-quote single quotes, process double-quote
escapes, resolve `\X` → `X`), then test each dequoted word against
`FIND_DANGEROUS`. Reject unquoted brace-expansion metacharacters
(`{`, `}`) in the find path.

---

## L2 — HIGH: Allowlisted commands accept write flags → arbitrary file writes

**Verdict: real. Reproduces.**

`isSafeSegment` validates only the bare head word; arguments are never
inspected. Several "read-only" allowlisted commands have write-capable
flags:

```bash
isSafeCommand('sort -o /tmp/sortout.txt /tmp/sortin.txt')   # → true — writes the output file
isSafeCommand('yq -i ".x = 1" file.yaml')                   # → true — rewrites the YAML in place
isSafeCommand('git diff --output=/tmp/gitout.txt HEAD~1 HEAD')  # → true — writes 41KB file
isSafeCommand('git log --output=/tmp/gitlog.txt -1')        # → true — writes
```

Verified: `bash -c "sort -o sortout.txt sortin.txt"` created the file;
`git diff --output=...` and `git log --output=...` wrote files in the
repo. `~` and globs in targets are not rejected, so
`sort -o ~/.ssh/authorized_keys /dev/null` (empty overwrite) is
reachable in principle.

**Root cause:** `isSafeSegment` head-only validation
(`return allowed.has(head)`); the write-path gate in `index.ts` never
sees these writes (they happen inside bash).

**Exploit:** full arbitrary file write to any user-writable path,
completely bypassing the plan-file/writePaths restriction.

**Fix:** per-command argument deny lists: reject `sort` args matching
`/^-o($|=)/`, `yq` args matching `/^-i($|=)|--inplace/`, and git
subcommand args matching `/^--output($|=)/`. Generalize into a
per-command dangerous-flag table (like `FIND_DANGEROUS`) as the pattern
going forward.

---

## L3 — HIGH: `isAllowedWritePath` trusts lexical paths → symlink escape

**Verdict: real. Reproduces.**

`isAllowedWritePath` uses `node:path.resolve`, which is purely lexical
and never follows symlinks. A symlink inside an allowed directory (or
pointing from the plan file itself) redirects the write outside the
allowlist:

```bash
mkdir -p /tmp/wtest/notebooks /tmp/wtest/out
ln -s /tmp/wtest/out /tmp/wtest/notebooks/leak
# isAllowedWritePath('/tmp/wtest', 'PLAN.md', ['notebooks/'], 'notebooks/leak/secret.txt') → true
# writeFileSync actually lands in /tmp/wtest/out/secret.txt
```

Plan-file variant: if `PLAN.md` is a symlink to an outside file, the
`resolved === planFile` check passes and `writeFileSync` overwrites the
symlink target. `ensurePlanFile`, `/plan clear`, and `openPlanView` all
write the plan file directly and are equally affected.

**Root cause:** no `realpath` canonicalization anywhere in the path gate.

**Exploit:** write anywhere via a symlink planted inside an allowed dir
or at the plan file path (requires the attacker to be able to create
symlinks in the project — e.g. a checkout containing a symlink).

**Fix:** canonicalize before comparing: `realpath` the resolved target
(falling back to realpath of the deepest existing ancestor + remaining
components for not-yet-created files), the plan file, and each
`writePaths` base; compare canonical forms. (Note: realpath-then-write
remains TOCTOU-racy against a concurrently swapped symlink — acceptable
for a model-facing gate; document it.)

---

## L4 — MEDIUM: `git ls-remote` performs network egress

**Verdict: real. Reproduces.**

`ls-remote` is in `SAFE_GIT_SUBCOMMANDS` but performs an outbound
connection (`git ls-remote origin` → true). Violates the no-network
invariant of plan mode.

**Fix:** remove `ls-remote` from `SAFE_GIT_SUBCOMMANDS`. Defense in
depth: reject git arguments matching URL / scp-style remote patterns
(`/^[a-z][a-z0-9+.-]*:\/\//`, `/^[^@\s]+@[^:\s]+:/`).

## L5 — MEDIUM: Generic base tool names let other extensions' tools pass the gate

The `tool_call` gate allowlists purely by tool name, and deep validation
is keyed on `isToolCallEventType` (name equality), not on which
extension provided the tool. A tool named `bash`/`read`/`grep` from
another extension would be treated as the built-in. Profile `*`-globs
(`bash*`) can expand to unvetted tools.

**Fix:** (1) restrict profile globs or warn loudly when a glob matches
>1 tool; (2) if pi exposes `sourceInfo`, key deep validation on the
built-in tools' provenance, not just the name.

## L7 — MEDIUM: Tilde expansion, globbing, and write-capable flags pass through

Unquoted `~`, `*`, `?`, `[`, `!` are not modeled by the splitter, so the
analyzed command differs from what bash executes; combined with
head-only validation this gives write primitives without any
metacharacter bypass (e.g. `sort -o ~/.ssh/authorized_keys /dev/null`,
`yq -i .x=1 configs/*.yaml`). Overlaps L2 — the flag deny-lists from L2
remove the actual primitive.

**Fix:** L2 fixes + defense-in-depth: reject unquoted `~` at word start
and unquoted glob metacharacters in write-capable positions.

---

## L6 — LOW: Unquoted `#` comment semantics mismatch (benign)

`isSafeCommand('ls # rm -rf /')` → true, and bash executes only `ls` —
the gate validates *more* than executes. Safe (comments never add
execution) but wrong. **Fix:** when an unquoted `#` starts a word,
truncate the remainder of the segment before validation (mirrors bash),
or fail closed.

## L8 — LOW: Trailing backslash model incomplete (currently fail-safe)

A lone trailing unquoted backslash is appended bare; for all reachable
inputs (`\r\n` pre-rejected) the model matches bash semantics, so no
divergence today. **Fix (hardening):** reject a command ending in an
unquoted backslash.

---

## Recommended test additions (`test/utils.test.ts`)

- `find . '-delete'`, `find . "-exec" rm -rf {} \;`, `find . -\delete`,
  `find . -e'xec' rm {} \;`, `find . -{d,d}elete`,
  `find . "-execdir" id \;`, `find . "-ok" rm {} \;`,
  `find . "-fprint" /tmp/x` → all **false**; plain `find . -name x` → true
- `sort -o /tmp/x /tmp/in` → false; `sort /tmp/in` → true
- `yq -i .x=1 f.yaml`, `yq --inplace ...` → false; `yq .x f.yaml` → true
- `git diff --output=/tmp/x HEAD~1 HEAD`, `git log --output=/tmp/x -1` → false
- `git ls-remote origin` → false; `git ls-remote` (no remote) → false
- Symlink fixtures: allowed dir containing a symlink out of the tree →
  `isAllowedWritePath` false; `PLAN.md` as symlink → false
- `ls # rm -rf /` → per chosen `#` policy (documented)
- Command ending in `\` → false (after L8 fix)

## Suggested fix order

1. **L2 + L7** (write flags) — one table change in `isSafeSegment`, highest impact
2. **L1** (find tokenization) — reuse the splitter's quote/escape logic
3. **L3** (realpath canonicalization) — new helper + fixtures
4. **L4** (drop `ls-remote`) — one-line
5. **L6/L8** (splitter hardening) — small
6. **L5** (tool provenance) — design decision, document first

---

## Resolution — 2026-08-13 (fixed)

All findings fixed and empirically re-verified on the merged code
(`node --experimental-strip-types` + real bash). Fixes implemented by a
3-agent parallel workflow (one top finding per agent + distributed
leads), integrated and re-verified by the main session.

| ID | Status | Fix | Regression tests | Verification |
|----|--------|-----|------------------|--------------|
| L1 | **fixed** | Quote-aware `tokenizeWords` (single-quote dequote, double-quote escapes, `\X`→`X`) in the `find` branch; dequoted words tested against `FIND_DANGEROUS`; unquoted `{`/`}` rejected in find segments | `test/security-l1-l6-l8.test.ts` (10 blocked obfuscations) | All 8 audit repros + 13 new obfuscations (`-e"x"ec`, `-exe'c`, `-\delete`, `-{d}d}elete`, `"−fprint0"`, …) blocked; `find . -name x` still allowed |
| L2 | **fixed** | `COMMAND_FLAG_DENY` per-command table applied to all argument words in `isSafeSegment`: `sort` `/^(-o\|--output)/` (covers `-o`, `-o=`, `-oFILE`, `--output`, `--output=`), `yq` `/^(-i\|--inplace)($\|=)/`, `git` `/^--output($\|=)/` (long diff `--output-indicator-*` flags stay allowed) | `test/security-l2-l4.test.ts` (11 blocked forms, 5 harmless forms) | All audit repros blocked incl. the previously-missed `sort --output FILE` long form; `sort /tmp/in`, `yq .x f.yaml`, `git status` still allowed |
| L3 | **fixed** | `canonicalPath()` (realpath with deepest-existing-ancestor fallback) applied to target, plan file, and every `writePaths` base before comparison; plan file canonicalized at directory level so a symlinked `PLAN.md` is rejected. TOCTOU race documented as accepted | `test/security-l3-l5.test.ts` (6 real-fixture tests: dir symlink escape, PLAN.md symlink, lexical fallback, `..` escape, in-tree base symlink) | Symlink escape + PLAN.md-symlink repros now `false`; non-existent paths keep lexical behavior (existing `/proj` tests green) |
| L4 | **fixed** | `ls-remote` removed from `SAFE_GIT_SUBCOMMANDS`; git args matching URL (`/^[a-z][a-z0-9+.-]*:\/\//`) or scp-style (`/^[^@\s]+@[^:\s]+:/`) remotes rejected | `test/security-l2-l4.test.ts` (`git ls-remote origin`, `git ls-remote`, URL/scp args) | Blocked; `git status`/`git diff` unaffected; `git ls-remote \| head` (composed) also blocked |
| L5 | **fixed** | `tool_call` gate is provenance-aware: `bash`/`edit`/`write` deep validation applies only when `sourceInfo.source === "builtin"` (lookalikes blocked unless profile-allowlisted); `plan_clear` must match the source captured at our own registration; `*`-glob profile entries warn when they expand to >1 tool | none (gate is a pi-runtime closure; verified by inspection + typecheck) | Code inspection: gate now keys on provenance, not just name |
| L6 | **fixed** | Unquoted word-start `#` truncates the remainder of the command (mirrors bash); `#` mid-word stays literal | `test/security-l1-l6-l8.test.ts` (`ls # rm -rf /` → true as plain `ls`; `find . -delete # comment` → still false; `echo a#b` → true) | Verified; semantics match bash |
| L7 | **fixed** | Unquoted word-initial `~` rejected in any segment (fail closed); quoted `'~'` unaffected; unquoted globs remain allowed (write flags now denied) | `test/security-l2-l4.test.ts` (`cat ~/x`, `cd ~`, `sort -o ~/.ssh/authorized_keys` blocked; `ls '~'` allowed) | Verified; `echo ~` is a documented conservative block |
| L8 | **fixed** | `splitComposition` rejects a command whose final character is an unquoted backslash | `test/security-l1-l6-l8.test.ts` (`ls \` → false) | Verified |

**Post-fix adversarial re-check:** 21 new bypass attempts (flag long
forms, attached forms, quote/backslash/brace splits, `git -c` smuggling,
composed pipelines, `#`-suffix smuggling) — all blocked; 13 positive
controls still allowed. Full suite: 44/44 tests + typecheck green.

**Known conservative false positives (accepted, fail-closed):**
`find . -name '-delete'` is blocked (dequoting makes it look like the
flag — passing it as a literal name arg is pointless anyway), and
`echo ~` / `cd ~` are blocked (word-initial tilde).

**Out of scope / noted:** the residual TOCTOU race in
`isAllowedWritePath` (symlink swapped between check and write) is
accepted for a model-facing gate; `read`/`grep`/`find`/`ls` lookalikes
from other extensions are not provenance-gated (no behavior gate
attached to them).
