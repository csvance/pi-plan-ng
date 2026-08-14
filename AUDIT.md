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

---

# AUDIT ROUND 2 — Re-audit of the fixed gate

**Date:** 2026-08-14
**Scope:** same surface as round 1 (post-fix code): `isSafeCommand` +
splitter/deny tables in `utils.ts`, `isAllowedWritePath`, the `tool_call`
gate in `index.ts`, config/profile trust model, `plan-view.ts`.
**Method:** fresh adversarial sweep — every candidate was first checked
through the real gate (`node --experimental-strip-types`) and then
**verified against real bash in an isolated fixture tree**
(`.scratch/audit2/`). Positive and negative controls ran alongside.
Baseline before audit: typecheck clean, 45/45 tests green (unchanged
after — no source was modified).

## Summary

| ID | Severity | Verdict | Title |
|----|----------|---------|-------|
| [R1](#r1-critical) | **critical** | real | `rg --pre` executes the plan file as a shell script — full RCE |
| [R2](#r2-critical) | **critical** | real | `sort --compress-program` executes sorted input as shell script — RCE |
| [R3](#r3-high) | **high** | real | Round-1 L2 deny table evaded by quoting/escaping — arbitrary file writes re-opened |
| [R4](#r4-high) | **high** | real | `git grep -O` / `--open-files-in-pager` execute an arbitrary pager command |
| [R5](#r5-high) | **high** | real | `uniq INPUT OUTPUT` positional output arg — content-controlled write anywhere |
| [R6](#r6-high) | **high** | real | Dangling symlinks escape `isAllowedWritePath` (round-1 L3 fix only covers existing targets) |
| [R7](#r7-medium) | medium | real | `git symbolic-ref HEAD <ref>` mutates `.git/HEAD` |
| [R8](#r8-medium) | medium | high-confidence | `tree -o FILE` writes a file (allowed by gate; `tree` not installed here — documented tree(1) behavior) |
| [R9](#r9-medium) | medium | real (by inspection) | Project config is untrusted: `planFile` may point anywhere; profiles grant bash/writePaths silently |
| [R10](#r10-low) | low | real | `GIT_REMOTE` check evaded by quoting (defense-in-depth layer only) |
| [R11](#r11-low) | low | real (gate-level) | `less -o/-O`, `rg --pager`, `bat --pager` allowed by gate, inert non-interactively |
| [R12](#r12-low) | low | noted | Hardlinks not detected by realpath canonicalization (tarball-shippable) |

**Bottom line:** plan mode's read-only guarantee is **again broken**, in
three independent ways: two direct **arbitrary-code-execution** paths
(`rg --pre`, `sort --compress-program`), a re-opening of the round-1 L2
write bypass via quoting (`sort '-o'`), plus new exec/write primitives
(`git grep -O`, `uniq OUT`), and a dangling-symlink escape of the write
allowlist. The structural cause is the same as round 1's L1/L2: the gate
validates **command heads** and a hand-maintained **deny table of flags**,
while bash offers many more write/exec-capable flags and positional forms
on the allowlisted heads.

---

## R1 — CRITICAL: `rg --pre` executes the plan file as a shell script

**Verdict: real. Reproduces. Gate allows it.**

```
ALLOW | rg --pre /bin/bash needle PLAN.md
$ rg --pre /bin/bash 'plan' PLAN.md   # PLAN.md contains "touch PWNED; echo ... > PROOF"
>>> rg --pre executed PLAN.md as bash (both marker files created)
```

`rg` is in `SAFE_COMMANDS`; its `--pre <cmd>` flag makes ripgrep pipe
every searched file through `cmd` **with the file as an argument**.
`/bin/bash PLAN.md` therefore executes the plan file — which is the one
file the agent may write **arbitrary content to** in plan mode
(`edit`/`write` gate passes any content into `PLAN.md`). The model
writes a shell payload as a "plan", then runs one allowed bash command:
result is arbitrary code execution as the user (deletions, network,
anything). No metacharacter smuggling needed.

`--pre=bash`, `--pager`, and `--pre-glob` combinations are all allowed
by the gate too (`--pager` is inert without a tty — see R11).

**Fix:** add `rg` flag deny rules for `--pre` (incl. `--pre=`), and
defense-in-depth `--pager`/`--pretty`-pager forms; ideally move `rg` to
an explicit safe-flag allowlist (it needs only patterns, paths, and
innocuous display flags).

## R2 — CRITICAL: `sort --compress-program` runs the input as a shell script

**Verdict: real. Reproduces. Gate allows it.**

```
ALLOW | sort --compress-program=/bin/bash big.txt
$ { seq 1 600000; echo "touch SORT_RCE_FINAL"; } | sort -S 64K --compress-program=/bin/bash
>>> SORT_RCE_FINAL created (compressor receives sorted chunks on stdin; bash executes them)
```

GNU sort invokes `--compress-program PROG` (popen-style) whenever it
spills to temp files; PROG receives the sorted data on stdin. With
`PROG=/bin/bash` (or any interpreter), **the lines being sorted are
executed as a script**. The attacker fully controls the input file, the
`-S` buffer size, and the repetition of payload lines, so landing a
payload line in a compressed chunk is trivial (repeat the payload line
throughout the input — verified: 600k `touch SORT_RCE_FINAL` lines →
marker created, exit 2 only because the *decompress* phase `bash -d`
errors *after* execution already happened). Even `sort
--compress-program=touch` executes a named binary.

The round-1 `COMMAND_FLAG_DENY` for `sort` covers only `-o|--output`.

**Fix:** deny `--compress-program` (incl. `=` form) for `sort`; better,
allowlist sort's safe flags (`-n -r -u -k -t -b -f -g -h -m -s -S -T?
— no: `-T` picks temp dir, keep it out unless needed`).

## R3 — HIGH: Round-1 L2 deny table evaded by quoting/escaping

**Verdict: real. Reproduces.**

The `find` branch dequotes before flag checks (round-1 L1 fix), but
`COMMAND_FLAG_DENY` and `GIT_REMOTE` are tested against **raw
whitespace-split words** — quotes/backslashes survive into the check but
are stripped by bash:

```
ALLOW | sort '-o' /tmp/pwn PLAN.md          # writes (verified: file created)
ALLOW | sort "-o" /tmp/pwn PLAN.md
ALLOW | sort -'o' /tmp/pwn PLAN.md
ALLOW | sort --'output' /tmp/pwn PLAN.md
ALLOW | yq '-i' .x=1 f.yaml                 # in-place edit
ALLOW | git diff '--output=/tmp/pwn' …      # output file created (verified)
ALLOW | git log --'output'=/tmp/pwn -1
ALLOW | git log --outp\ut=/tmp/pwn -1
```

Real bash confirms `sort '-o' q1.out s_in.txt` writes the file and
`git diff '--output=…'` creates the output file — **arbitrary file
write is re-opened exactly as in round-1 L2**, one quote character
later. `sort -{o,p}` brace form is also allowed by the gate but is a
bash error in practice (the expanded `-p` breaks sort) — still worth
blocking for uniformity.

**Fix:** run **all** argument checks (COMMAND_FLAG_DENY, GIT_REMOTE) on
`tokenizeWords(segment)` output — the dequoting tokenizer already
exists; only the find branch uses it today.

## R4 — HIGH: `git grep -O` / `--open-files-in-pager` execute a pager command

**Verdict: real. Reproduces non-interactively (stdin </dev/null, no tty).**

```
ALLOW | git grep -Otouch needle
ALLOW | git grep --open-files-in-pager=touch needle
ALLOW | git grep -O'touch /tmp/pwn' needle
$ git grep -O'touch …/GIT_GREP_PWN' needle </dev/null   → marker created
$ git grep --open-files-in-pager='touch ../GG_OFP_PWN' needle </dev/null → marker created
```

`grep` is in `SAFE_GIT_SUBCOMMANDS`; `-O<pager>` makes git run the pager
command on the matching files — with **arbitrary arguments smuggled via
quoting** (the gate's raw word split doesn't stop `-O'touch /tmp/pwn'`
from being one argv after bash dequoting). Combined with R1's trick of
putting a payload in the plan file, `-O'/bin/bash PLAN.md'`-style forms
give command execution directly.

**Fix:** deny `-O`-prefixed and `--open-files-in-pager` words in git
segments (post-dequote, per R3).

## R5 — HIGH: `uniq INPUT OUTPUT` — positional output file

**Verdict: real. Reproduces.**

```
ALLOW | uniq PLAN.md /home/x/.bashrc
$ uniq payload.txt /anywhere/target.txt   # writes dedup'd content
```

`uniq` has no write **flag** — its second positional argument *is* the
output file. Content = input lines with adjacent duplicates removed;
since the agent controls PLAN.md's content, a payload of unique lines
passes through verbatim → **content-controlled arbitrary file write**
(overwrite `~/.bashrc`, `~/.ssh/authorized_keys`, cron files, …). No
flag deny-list can fix this; it needs positional-argument modeling.

**Fix:** special-case `uniq` to allow at most **one** file argument (like
`sort`'s implicit single-input assumption), or drop `uniq` from
`SAFE_COMMANDS` (it's rarely load-bearing given `sort -u`).

## R6 — HIGH: dangling symlinks escape `isAllowedWritePath`

**Verdict: real. Reproduces (both writePaths and plan-file variants).**

Round-1 L3 canonicalizes with `realpath`, falling back to the deepest
existing ancestor **lexically** when the path doesn't exist. A
**dangling** symlink defeats that: `realpathSync` fails on it, the
lexical fallback compares the *link's own path* (inside the allowed
set), but `writeFileSync` **follows the link** and creates the target:

```
ln -s ../outside/pwned.md  notebooks/leak.md    # dangling
isAllowedWritePath(cwd, plan, ['notebooks/'], 'notebooks/leak.md') → true  (!)
writeFileSync('notebooks/leak.md') → creates ../outside/pwned.md    (verified)

ln -s ../outside/stolen-plan.md  PLAN.md        # dangling
isAllowedWritePath(cwd, PLAN.md, undefined, 'PLAN.md') → true  (!)
writeFileSync(PLAN.md) → creates ../outside/stolen-plan.md          (verified)
```

Preconditions match round-1 L3: a symlink planted in the project (e.g.
crafted repo checkout); dangling links are *more* likely to survive a
copy/clone inspection.

**Fix:** in `canonicalPath`, when `realpathSync` fails, `lstatSync` each
missing component from the top down: if the final (or any) missing
component is a symlink, resolve it with `readlinkSync` and continue
canonicalizing the target (loop). Cheaper hardening: if the **last**
component of the target is a symlink and realpath failed → reject (fail
closed).

## R7 — MEDIUM: `git symbolic-ref HEAD <ref>` mutates `.git/HEAD`

**Verdict: real. Reproduces.** `symbolic-ref` is in
`SAFE_GIT_SUBCOMMANDS` as a read, but the 2-argument form **writes**
`.git/HEAD` (verified: branch switched to `pwned-branch`, no other
write mechanism involved). Not arbitrary content, but it is repo-state
mutation and a stepping stone (e.g. point HEAD at a crafted ref before
`/plan go`).

**Fix:** allow `symbolic-ref` only in query form — zero or one argument
(`git symbolic-ref [-q] [--short] [ref]`); reject ≥2 non-flag args.

## R8 — MEDIUM: `tree -o FILE` writes a file

`tree` is allowlisted; `tree -o FILE` sends output to FILE instead of
stdout (documented tree(1) behavior; `tree` is not installed in this
sandbox, so not empirically verified here). Content = directory listing,
so this is a junk/overwrite primitive rather than content-controlled —
but it can clobber files (`tree -o ~/.bashrc .`). Gate verdict: ALLOW.

**Fix:** deny `-o`/`--output-file` for `tree` (post-dequote).

## R9 — MEDIUM: project config is trusted for security-relevant decisions

`loadConfig` merges `.pi/plan-mode.json` **from the project** (a cloned
repo) into the gate's inputs, and nothing validates the result:

- `"planFile": "/home/user/.bashrc"` (absolute, outside the repo) —
  `getPlanFilePath` resolves it verbatim; entering plan mode in that
  repo then makes `edit`/`write` on `~/.bashrc` pass the write gate as
  "the plan file". `/plan` alone triggers it — no profile opt-in needed.
- A profile with `"bash": ["bash"]`, `"writePaths": ["/"]`, or a broad
  tool glob is activated by a single `/plan <innocuous-name>`; the only
  feedback shown is the profile's name and attacker-authored
  `description` string — the actual grants are never displayed.

Verified by inspection (`loadConfig`, `getPlanFilePath`,
`isAllowedWritePath`, `enablePlanMode`). This is a design/trust-model
issue rather than a parsing bug: the repo already supplies extensions,
but config-driven gate decisions deserve a guardrail.

**Fix:** (a) require `planFile` to resolve inside `cwd` (absolute/outside
paths only via an explicit global-config opt-in); (b) on profile
activation, display the granted tools/bash/writePaths in the notify;
(c) optionally require confirmation for profiles sourced from project
config.

## R10 — LOW: `GIT_REMOTE` evaded by quoting

`git log 'https://evil.com/x'` → ALLOW (quoted word doesn't match the
regex; the scp-quoted variant only matched because `'` happens to pass
`[^@\s]`). Impact is limited — the actual network subcommands
(clone/fetch/ls-remote) are already blocked by the subcommand
allowlist, so this regex is defense-in-depth. Fix together with R3
(dequote before matching).

## R11 — LOW: tty-dependent exec/write flags allowed by the gate

Verified inert through the non-interactive bash tool (no tty):
`less -o`/`-O` logfile (no file created), `rg --pager` (exit 2),
`bat --pager` (ignored). If the bash tool ever gains a pty, or a
profile brings an interactive terminal, these become live
primitives. Defense-in-depth: add deny entries now (`less` `-o`/`-O`
prefixed words and `LOGFILE`-style long opts, `rg`/`bat` `--pager`).

## R12 — LOW (noted): hardlinks bypass canonicalization

`realpath` cannot see hardlinks (same inode, different path): a
hardlink planted inside an allowed directory (hardlinks survive tar
archives) writes through to the linked target. Same accepted-risk family
as the documented TOCTOU race; requires attacker filesystem access or a
crafted tarball. Note-only; no fix proposed beyond documentation.

---

## Round 2 — negative results (controls that held)

- `find` long-option forms (`--delete`, `--exec`) are rejected by GNU
  find itself ("unknown predicate") — the single-dash `FIND_DANGEROUS`
  regex is not bypassable that way.
- The round-1 find dequoting tokenizer held against a fresh battery
  (`-e"x"ec`, `-'exec'`, `-\exec`, `-e\xec`, brace forms).
- `od`, `cmp`, `diff`, `column` have no write/exec flags (their
  `--output`-shaped flags are format/separator options or don't exist).
- Splitter held on: tabs, escaped `\<`, mid-word `~`, quoted `~`, `$`,
  backticks, `;`, `(`, `)`, `<`, `>`, `&`, `|&`, `||`, comments,
  trailing backslash, empty segments, CRLF/NUL.
- Malformed tool input (`command: undefined`) makes the gate throw —
  pi's extension runner propagates the throw and the tool call **fails
  closed** (verified in agent-session.js).
- `plan-view.ts` writes only the plan file path passed to it.
- The 45-test suite (incl. round-1 regression suites) stays green
  throughout; no source files were modified by this audit.

## Round 2 — recommended fix order

1. **R3** (dequote everything through `tokenizeWords`) — small,
   mechanical, and it re-closes L2-class writes; foundation for the rest.
2. **R1 + R2 + R4 + R5 + R7 + R8** (new deny entries + `uniq` arity +
   `symbolic-ref` query form) — one focused pass over the flag table;
   consider inverting to per-command **safe-flag allowlists** to stop the
   arms race the deny list keeps losing.
3. **R6** (dangling-symlink canonicalization) — targeted `canonicalPath`
   change + fixtures (add dangling-link cases to `security-l3-l5`).
4. **R9** (config trust: constrain `planFile`, surface profile grants).
5. **R10/R11/R12** (defense-in-depth + documentation).

---

## Round 2 — Resolution (R1/R2 criticals fixed; R3 foundation applied)

**Date:** 2026-08-14 (same day as round 2)
**Scope:** the two **critical** findings only (R1, R2), plus the R3 dequoting
foundation they depend on — done as one focused pass, per the round-2 fix
order. R4–R12 remain open and are tracked above.

### What changed (`utils.ts`)

| ID | Status | Fix |
|----|--------|-----|
| R1 | **fixed** | `rg` added to `COMMAND_FLAG_DENY`: `/^--pre($|=)/` and defense-in-depth `/^--pager($|=)/` (dequoted-token check; quoted/escaped forms blocked too) |
| R2 | **fixed** | `sort` deny list extended with `/^--compress-program($|=)/` |
| R3 | **fixed** | `COMMAND_FLAG_DENY` and `GIT_REMOTE` now run on `tokenizeWords(segment)` output (the round-1 find dequoter), so `sort '-o'`, `git --'output'=...`, `git log --outp\ut=...`, and quoted URLs (`R10`) are all tested as the argv bash passes. Head/subcommand allowlist checks stay on raw words (quoted heads fail closed); the L7 tilde check stays raw so `ls '~'` remains allowed |
| R1/R2 (hardening) | **fixed** | Unquoted `{` `}` brace expansion now rejected in **every** segment (was find-only). During verification this audit's assumed-inert brace class turned out to be a **live bypass**: `rg --p{re,re}=/bin/bash` and `sort --compress-{,}program=/bin/bash` expand to two valid copies of the denied flag and **executed** in real bash (both markers created). The blanket ban closes that; quoted braces remain fine |

### Verification

- All round-2 repros blocked through the real gate (`node --experimental-strip-types`):
  `rg --pre /bin/bash needle PLAN.md`, `rg --pre=bash …`, `sort
  --compress-program=/bin/bash big.txt`, `sort --compress-program /bin/bash big.txt`,
  plus quoted (`'--pre'`, `"-o"`), escaped (`--outp\ut=`), and brace-duplicate
  forms → all `false`.
- The two audit repros were first re-confirmed **live against real bash**
  (R1: `rg --pre /bin/bash PLAN.md` executed `PLAN.md`; R2: 300k interleaved
  payload lines + `-S 64K --compress-program=/bin/bash` created the marker;
  brace-duplicate forms also executed) — then confirmed blocked by the fixed
  gate.
- Positive controls unchanged: `rg -n`, `rg --pretty`, `rg --pre-glob '*.md'`
  (inert alone), `sort big.txt`, `sort -n -u -S 64K`, `git status`, `git diff`
  → all `true`; real bash still runs them.
- Full suite green: **50/50 tests** (45 baseline + 5 new in
  `test/security-r1-r3.test.ts`) + `tsc --noEmit` clean. No existing test
  changed.

### Still open (not in scope of this pass)

R4 (`git grep -O`), R5 (`uniq OUT`), R6 (dangling-symlink escape), R7
(`git symbolic-ref` write form), R8 (`tree -o`), R9 (config trust), R11
(tty-dependent flags), R12 (hardlinks). Note for the next pass: the brace
ban introduced here should also be re-tested against R4/R5/R8 when those
flags are denied, and the audit's suggestion to invert the deny tables into
per-command **safe-flag allowlists** remains the recommended structural fix.

---

## Round 2 — Resolution (R4/R5/R6 high items fixed)

**Date:** 2026-08-14 (same day as round 2)
**Scope:** the three **high** findings from round 2, done one at a time after
R1/R2/R3. Each finding was re-verified live against the real tools before the
fix and re-verified through the real gate after.

### What changed

| ID | Status | Fix |
|----|--------|-----|
| R4 | **fixed** | New `GIT_SUBCOMMAND_FLAG_DENY` table, checked post-dequote in the git branch: `grep` denies `/^-O/` and `/^--open-files-in-pager($|=)/`. Scoped to the subcommand so `git diff -O<orderfile>` (read-only) and `git grep -o` stay allowed. Verified live first: `git grep -O"touch /tmp/x" needle` and `git grep --open-files-in-pager="touch /tmp/x" needle` both executed `touch` in a real repo |
| R5 | **fixed** | `uniq` positional-arity model: at most **one** positional allowed (the second positional is the output file — content-controlled write). `-f`/`-s`/`-w` and their long forms consume a separate value token; `--` makes the rest positional. Read-only forms (`uniq`, `uniq file`, `uniq -c file`, `uniq -f 2 file`, `uniq --skip-fields=2 file`) stay allowed; `uniq PLAN.md /home/x/.bashrc`, `uniq -f 2 in out`, `uniq -- PLAN.md out` blocked. Verified live: `uniq payload.txt /tmp/out` wrote the file |
| R6 | **fixed** | `canonicalPath` now resolves *dangling* symlinks: when `realpathSync` fails on a component, `readlinkSync` resolves it and canonicalization continues on the target (recursion depth-capped at 40, mirroring the kernel ELOOP limit; cyclic chains return unresolved — the write itself fails ELOOP). The gate now rejects both repro variants (dangling `notebooks/leak.md` → `../outside/pwned.md`, dangling `PLAN.md` → `../outside/stolen-plan.md`), which previously returned `true` and wrote outside the allowed set. **Direct plan-file write sites hardened too** (`index.ts` `ensurePlanFile`, `/plan clear`, `plan_reset`; `plan-view.ts` viewer save): new exported `isSymlink` (lstat-based, detects dangling links) and each site refuses to write through a symlinked plan file with a visible notify — previously `writeFileSync` followed the link and clobbered its target |

### Verification

- R4/R5 gate sweep: all blocked forms `false`, all control forms `true`.
- R6: both dangling-symlink repros `false` through the gate; the
  `ensurePlanFile`-style guard leaves the outside target untouched while
  still creating a genuinely new file inside the allowed dir.
- Full suite green: **59/59 tests** (54 baseline + 4 new R6 fixtures in
  `test/security-l3-l5.test.ts` + 1 new `isSymlink` test; R4/R5 cases live in
  `test/security-r4-r6.test.ts`) + `tsc --noEmit` clean.

### Still open (unchanged)

R7 (`git symbolic-ref` write form), R8 (`tree -o`), R9 (config trust), R11
(tty-dependent flags), R12 (hardlinks). Structural recommendation stands:
move from per-command deny lists to per-command **safe-flag allowlists**.


