import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildEditorTheme,
  buildMarkdownTheme,
  buildPlanModeTools,
  buildWidgetLines,
  checkSafeCommand,
  describePlanModeBashRules,
  describeUnsafePlanMode,
  expandToolEntry,
  getPlanFilePath,
  isAllowedWritePath,
  isSafeCommand,
  mergeProfiles,
  resolvePlanFileIn,
  TUI_WIDGET_LINE_CAP,
} from "../utils.ts";

/** Minimal theme stub — colors are stripped, matching plain terminal output. */
const noopTheme = {
  bold: (t: string) => t,
  fg: (_color: string, t: string) => t,
};

describe("isSafeCommand", () => {
  it("allows bare allowlisted commands", () => {
    assert.equal(isSafeCommand("ls"), true);
    assert.equal(isSafeCommand("cat file.txt"), true);
    assert.equal(isSafeCommand("grep 'foo bar' src/"), true);
    assert.equal(isSafeCommand("git status"), true);
    assert.equal(isSafeCommand("git log --oneline -5"), true);
    assert.equal(isSafeCommand("git diff HEAD~1 HEAD"), true);
    assert.equal(isSafeCommand("find . -name '*.ts'"), true);
  });

  it("allows cd (navigation)", () => {
    assert.equal(isSafeCommand("cd src"), true);
    assert.equal(isSafeCommand("cd .."), true);
    assert.equal(isSafeCommand("cd /tmp"), true);
  });

  it("allows read-only composition: pipelines and && chains", () => {
    const ok = [
      "ls | wc -l",
      "ls && pwd",
      "grep foo file | head -20",
      "cd src && ls",
      "cd src && grep -r foo . | head -20",
      "cat f | grep x | head -3",
      "cd src&&ls",
      "grep -n 'a|b' file",
      "echo 'a && b'",
      "echo \"x | y\"",
      "git status | head -5",
      "find . -name '*.ts' | wc -l",
    ];
    for (const cmd of ok) {
      assert.equal(isSafeCommand(cmd), true, `expected allowed: ${cmd}`);
    }
  });

  it("blocks shell metacharacters (separators, substitution, redirection)", () => {
    const bad = [
      "ls; rm -rf /",
      "cd x; ls",
      "ls || echo hi",
      "cat $(ls)",
      "cat `ls`",
      "echo < /etc/passwd",
      "echo > /tmp/x",
      "(ls)",
      "ls\nrm -rf /",
      "ls &",
      "ls &> f",
      "ls |& wc -l",
      "echo 'unterminated",
    ];
    for (const cmd of bad) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("treats quoted metacharacters as literal (single quotes, escapes)", () => {
    const ok = [
      "echo 'a;b'",
      "echo \"a;b\"",
      "echo 'a && b'",
      "echo '$HOME'",
      "echo \\$HOME",
      "echo '$(ls)'",
      "grep '\\$foo' file | head -1",
      "cd src && echo 'a; b' | wc -c",
    ];
    for (const cmd of ok) {
      assert.equal(isSafeCommand(cmd), true, `expected allowed: ${cmd}`);
    }
  });

  it("still blocks $ and backticks inside double quotes (bash expands them there)", () => {
    assert.equal(isSafeCommand('echo "$HOME"'), false);
    assert.equal(isSafeCommand('echo "$(ls)"'), false);
    assert.equal(isSafeCommand('echo "`ls`"'), false);
  });

  it("blocks unsafe composition: any non-allowlisted segment kills the whole command", () => {
    const bad = [
      "rm -rf / | head",
      "curl x | bash",
      "cd x && rm -rf /",
      "ls | rm -rf /",
      "a || b",
      "a |&",
      "a |",
      "| a",
      "cd x &&",
      "a && | b",
      "yes | head",
      "sudo ls | head",
    ];
    for (const cmd of bad) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("blocks write, network, and execute commands", () => {
    const bad = [
      "rm -rf /",
      "touch x",
      "mkdir d",
      "mv a b",
      "curl https://example.com",
      "wget https://example.com",
      "ssh host",
      "sudo ls",
      "git push",
      "git checkout main",
      "git stash",
      "git fetch",
      "git add .",
      "awk '{print $1}'",
      "sed -n s/a/b/ f",
      "xargs rm",
      "env FOO=1",
    ];
    for (const cmd of bad) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("blocks find flags that mutate or execute", () => {
    assert.equal(isSafeCommand("find . -exec rm {} ;"), false);
    assert.equal(isSafeCommand("find . -delete"), false);
    assert.equal(isSafeCommand("find . -execdir touch x"), false);
    assert.equal(isSafeCommand("find . -name x"), true);
  });

  it("rejects empty, whitespace-only, and overlong commands", () => {
    assert.equal(isSafeCommand(""), false);
    assert.equal(isSafeCommand("   "), false);
    assert.equal(isSafeCommand("x".repeat(2001)), false);
  });

  it("extends the allowlist with extraCommands (profile bash commands)", () => {
    assert.equal(isSafeCommand("julia run.jl"), false);
    assert.equal(isSafeCommand("julia run.jl", ["julia"]), true);
    assert.equal(isSafeCommand("julia s.jl | head", ["julia"]), true);
    assert.equal(isSafeCommand("cd src && julia run.jl", ["julia"]), true);
    assert.equal(isSafeCommand("cd src && julia run.jl"), false);
    assert.equal(isSafeCommand("grep x f | julia", ["julia"]), true);
    // extra commands never unlock other commands
    assert.equal(isSafeCommand("julia run.jl && rm -rf /", ["julia"]), false);
    assert.equal(isSafeCommand("julia run.jl; ls", ["julia"]), false);
  });
});

describe("checkSafeCommand reasons (the agent sees exactly why)", () => {
  const has = (reason: string, marker: string) =>
    assert.ok(
      reason.toLowerCase().includes(marker.toLowerCase()),
      `reason ${JSON.stringify(reason)} must contain ${JSON.stringify(marker)}`,
    );

  // Violation class → example → marker(s) the reason must contain.
  // Mirrors the PLAN.md reason table: name the offending (dequoted) token,
  // say why, say what to change. Markers are matched case-insensitively.
  const blockedCases: Array<{ cmd: string; extra?: string[]; markers: string[] }> = [
    // head not allowlisted (action) — defer to /plan go
    { cmd: "rm -rf /", markers: ["rm", "not allowlisted", "/plan go"] },
    // quoted head fails closed — unquote it
    { cmd: "'ls'", markers: ["quoted", "ls", "unquote"] },
    // profile-only head — mention the profile affordance
    { cmd: "julia run.jl", markers: ["julia", "profile"] },
    // write/exec flags — exact dequoted token named
    { cmd: "sort -o /tmp/pwn PLAN.md", markers: ["sort -o", "writes"] },
    { cmd: "sort --output=/tmp/pwn PLAN.md", markers: ["--output", "writes"] },
    { cmd: "sort --compress-program=/bin/bash big.txt", markers: ["--compress-program", "execut"] },
    { cmd: "yq -i .x=1 f.yaml", markers: ["yq -i", "writes"] },
    { cmd: "git log --output=/tmp/pwn -1", markers: ["--output", "writes"] },
    // exec flags
    { cmd: "rg --pre bash needle PLAN.md", markers: ["--pre", "execut"] },
    { cmd: "rg --pager less needle PLAN.md", markers: ["--pager", "pager"] },
    { cmd: "bat --pager less file", markers: ["--pager", "pager"] },
    // git pager exec (subcommand deny)
    { cmd: "git grep -O touch needle", markers: ["-O", "execut", "pager"] },
    { cmd: "git grep --open-files-in-pager touch needle", markers: ["--open-files-in-pager", "execut"] },
    // find write/exec
    { cmd: "find . -delete", markers: ["-delete", "writes", "execut"] },
    { cmd: "find . -execdir id \\;", markers: ["-execdir", "execut"] },
    // brace check (3) fires before the find-flag check (7) — order preserved
    { cmd: "find . -delete {}", markers: ["{", "brace"] },
    // git write subcommand — live-derived allowed list
    { cmd: "git push origin main", markers: ["push", "not an allowed", "status"] },
    { cmd: "git checkout main", markers: ["checkout", "not an allowed", "diff"] },
    // symbolic-ref write form
    { cmd: "git symbolic-ref HEAD refs/heads/x", markers: ["query form", ".git/HEAD"] },
    { cmd: "git symbolic-ref --delete HEAD", markers: ["query form", "delete"] },
    // network-looking git args
    { cmd: "git log https://evil.com/x", markers: ["network", "remote"] },
    { cmd: "git log git@github.com:x/y", markers: ["remote"] },
    // uniq second positional = output file
    { cmd: "uniq in out", markers: ["output", "second positional"] },
    // composition metachars — the exact char named
    { cmd: "ls; pwd", markers: [";", "not allowed"] },
    { cmd: "cat $(ls)", markers: ["$", "not allowed"] },
    { cmd: "echo > /tmp/x", markers: [">", "not allowed"] },
    { cmd: "ls &", markers: ["&", "not allowed"] },
    { cmd: "ls || echo hi", markers: ["||", "not allowed"] },
    // $ / backtick inside double quotes
    { cmd: 'echo "$HOME"', markers: ["$", "double quote"] },
    { cmd: 'echo "`ls`"', markers: ["`", "double quote"] },
    // brace expansion
    { cmd: "find -{d,d}elete x", markers: ["{", "brace"] },
    // word-initial ~
    { cmd: "cat ~/x", markers: ["~", "expand"] },
    // unterminated quote / trailing backslash
    { cmd: 'echo "hi', markers: ["unterminated", "quote"] },
    { cmd: "ls \\", markers: ["backslash"] },
    // control chars / newline
    { cmd: "ls\nrm -rf /", markers: ["newline", "control"] },
    // empty segment (plain) — names the separator
    { cmd: "cd x &&", markers: ["empty", "after"] },
    { cmd: "ls |", markers: ["empty", "after"] },
    // empty segment (comment-truncated) — explains the #
    { cmd: "ls && # note", markers: ["empty", "#", "comment"] },
    { cmd: "# note", markers: ["empty", "comment"] },
    // too long / blank
    { cmd: "x".repeat(2001), markers: ["length"] },
    { cmd: "", markers: ["empty"] },
    { cmd: "   ", markers: ["empty"] },
  ];

  for (const { cmd, extra, markers } of blockedCases) {
    it(`explains why ${JSON.stringify(cmd.slice(0, 40))}${cmd.length > 40 ? "…" : ""} is blocked`, () => {
      const res = checkSafeCommand(cmd, extra);
      assert.equal(res.ok, false, `expected blocked: ${JSON.stringify(cmd)}`);
      if (!res.ok) for (const m of markers) has(res.reason, m);
    });
  }

  it("prefixes the failing segment for multi-segment commands only", () => {
    const multi = checkSafeCommand("cd src && rm -rf /");
    assert.equal(multi.ok, false);
    if (!multi.ok) {
      has(multi.reason, 'in segment 2 ("rm -rf /")');
      has(multi.reason, "rm");
    }
    const single = checkSafeCommand("rm -rf /");
    assert.equal(single.ok, false);
    if (!single.ok) assert.ok(!single.reason.includes("in segment"), "no segment prefix for a single segment");
    // first failure wins, left-to-right
    const first = checkSafeCommand("rm -rf / && sort -o /tmp/x f");
    assert.equal(first.ok, false);
    if (!first.ok) has(first.reason, "in segment 1");
  });

  it("never produces a reason for an allowed command (negative control)", () => {
    const allowed = [
      "ls", "cat file.txt", "grep 'foo bar' src/", "git status", "git log --oneline -5",
      "git diff HEAD~1 HEAD", "find . -name '*.ts'", "cd src", "cd ..", "cd /tmp",
      "ls | wc -l", "ls && pwd", "grep foo file | head -20", "cd src && ls",
      "cat f | grep x | head -3", "cd src&&ls", "grep -n 'a|b' file", "echo 'a && b'",
      'echo "x | y"', "git status | head -5", "find . -name '*.ts' | wc -l",
      "echo 'a;b'", 'echo "a;b"', "echo 'a && b'", "echo '$HOME'", "echo \\$HOME",
      "echo '$(ls)'", "grep '\\$foo' file | head -1", "cd src && echo 'a; b' | wc -c",
      "find . -name x", "cd src && find . -name x | head -3", "find . -name '{x}'",
      "sort /tmp/in", "yq .x f.yaml", "git diff --output-indicator-new=x HEAD~1 HEAD",
      "ls '~'", "cd src && sort x | head", "git grep needle", "git grep -n needle",
      "git grep -o needle", "git grep -e 'pat' -- '*.md'", "git diff -Oorderfile HEAD~1 HEAD",
      "git grep needle | head", "uniq", "uniq file", "uniq -c file", "uniq -u -d file",
      "uniq -f 2 file", "uniq -f2 file", "uniq --skip-fields=2 file", "uniq -i file",
      "uniq file | head", "git symbolic-ref HEAD", "git symbolic-ref --short HEAD",
      "git symbolic-ref -q HEAD", "git symbolic-ref -q --short HEAD", "tree", "tree -L 2 .",
      "tree -a -d", "tree -J", "less file", "less -N file", "bat file", "bat -n file",
      "bat --paging=always file", "rg -n needle PLAN.md", "rg --pretty needle PLAN.md",
      "rg --no-line-number needle PLAN.md", "rg --pre-glob '*.md' needle PLAN.md",
      "rg -g '*.md' needle .", "sort big.txt", "sort -n -u -S 64K big.txt",
      "ls # rm -rf /", "echo a#b",
    ];
    for (const cmd of allowed) {
      assert.equal(checkSafeCommand(cmd).ok, true, `expected allowed: ${JSON.stringify(cmd)}`);
    }
  });

  it("is deterministic: the same blocked command yields the same reason", () => {
    const samples = ["rm -rf /", "sort -o /tmp/pwn PLAN.md", "ls; pwd", "git push origin main", "cd x &&"];
    for (const cmd of samples) {
      const a = checkSafeCommand(cmd);
      const b = checkSafeCommand(cmd);
      assert.deepEqual(a, b, `deterministic reason for ${JSON.stringify(cmd)}`);
      if (!a.ok) {
        assert.equal(typeof a.reason, "string");
        assert.ok(a.reason.length > 0, "non-empty reason");
      }
    }
  });

  it("parity: isSafeCommand verdict equals checkSafeCommand.ok on the full corpus", () => {
    // Union of the blocked+allowed corpora from utils.test.ts and the
    // security-*.test.ts suites (snapshot — keeps the refactor honest).
    const corpus: Array<{ cmd: string; extra?: string[]; expect: boolean }> = [
      // allowed
      ...["ls", "cat file.txt", "grep 'foo bar' src/", "git status", "git log --oneline -5",
        "git diff HEAD~1 HEAD", "find . -name '*.ts'", "cd src", "cd ..", "cd /tmp",
        "ls | wc -l", "ls && pwd", "grep foo file | head -20", "cd src && ls",
        "cat f | grep x | head -3", "cd src&&ls", "grep -n 'a|b' file", "echo 'a && b'",
        'echo "x | y"', "git status | head -5", "find . -name '*.ts' | wc -l",
        "echo 'a;b'", 'echo "a;b"', "echo 'a && b'", "echo '$HOME'", "echo \\$HOME",
        "echo '$(ls)'", "grep '\\$foo' file | head -1", "cd src && echo 'a; b' | wc -c",
        "find . -name x", "cd src && find . -name x | head -3", "find . -name '{x}'",
        "sort /tmp/in", "yq .x f.yaml", "git diff --output-indicator-new=x HEAD~1 HEAD",
        "ls '~'", "cd src && sort x | head", "git grep needle", "git grep -n needle",
        "git grep -o needle", "git grep -e 'pat' -- '*.md'", "git diff -Oorderfile HEAD~1 HEAD",
        "git grep needle | head", "uniq", "uniq file", "uniq -c file", "uniq -u -d file",
        "uniq -f 2 file", "uniq -f2 file", "uniq --skip-fields=2 file", "uniq -i file",
        "uniq file | head", "git symbolic-ref HEAD", "git symbolic-ref --short HEAD",
        "git symbolic-ref -q HEAD", "git symbolic-ref -q --short HEAD", "tree", "tree -L 2 .",
        "tree -a -d", "tree -J", "less file", "less -N file", "bat file", "bat -n file",
        "bat --paging=always file", "rg -n needle PLAN.md", "rg --pretty needle PLAN.md",
        "rg --no-line-number needle PLAN.md", "rg --pre-glob '*.md' needle PLAN.md",
        "rg -g '*.md' needle .", "sort big.txt", "sort -n -u -S 64K big.txt",
        "ls # rm -rf /", "echo a#b"]
        .map((cmd) => ({ cmd, expect: true })),
      // blocked
      ...["ls; rm -rf /", "cd x; ls", "ls || echo hi", "cat $(ls)", "cat `ls`",
        "echo < /etc/passwd", "echo > /tmp/x", "(ls)", "ls\nrm -rf /", "ls &", "ls &> f",
        "ls |& wc -l", "echo 'unterminated", 'echo "$HOME"', 'echo "$(ls)"', 'echo "`ls`"',
        "rm -rf / | head", "curl x | bash", "cd x && rm -rf /", "ls | rm -rf /", "a || b",
        "a |&", "a |", "| a", "cd x &&", "a && | b", "yes | head", "sudo ls | head",
        "rm -rf /", "touch x", "mkdir d", "mv a b", "curl https://example.com",
        "wget https://example.com", "ssh host", "sudo ls", "git push", "git checkout main",
        "git stash", "git fetch", "git add .", "awk '{print $1}'", "sed -n s/a/b/ f",
        "xargs rm", "env FOO=1", "find . -exec rm {} ;", "find . -delete",
        "find . -execdir touch x", "", "   ", "x".repeat(2001), "julia run.jl",
        "cd src && julia run.jl", "find . '-delete'", 'find . "-exec" rm -rf {} \\;',
        "find . -\\delete", "find . -e'xec' rm {} \\;", "find . -{d,d}elete",
        'find . "-execdir" id \\;', 'find . "-ok" rm {} \\;', 'find . "-fprint" /tmp/x',
        "find . -delete # comment", "sort -o /tmp/x /tmp/in", "sort -o=/tmp/x",
        "sort -o/tmp/x", "sort --output /tmp/x", "sort --output=/tmp/x",
        'yq -i ".x = 1" f.yaml', "yq -i=true", 'yq --inplace ".x = 1" f.yaml',
        "yq --inplace", "git diff --output=/tmp/x HEAD~1 HEAD", "git log --output=/tmp/x -1",
        "git ls-remote origin", "git ls-remote", "git diff https://example.com/x",
        "git log git@github.com:x/y", "sort -o ~/.ssh/authorized_keys /dev/null",
        "cat ~/x", "cd ~", "sort -o /tmp/x f | head", "rg --pre /bin/bash needle PLAN.md",
        "rg --pre=bash needle PLAN.md", "rg --pre='cat' needle PLAN.md",
        "rg '--pre' /bin/bash needle PLAN.md", 'rg "--pre" /bin/bash needle PLAN.md',
        "rg --p're' /bin/bash needle PLAN.md", "rg --pre-glob '*.md' --pre /bin/bash needle PLAN.md",
        "rg --p{re,re}=/bin/bash needle PLAN.md", "rg --pager less needle PLAN.md",
        "rg --pager='less' needle PLAN.md", "sort --compress-program=/bin/bash big.txt",
        "sort --compress-program /bin/bash big.txt", "sort '--compress-program'=/bin/bash big.txt",
        'sort "--compress-program=/bin/bash" big.txt', "sort --compress-{,}program=/bin/bash big.txt",
        "sort --{compress-,compress-}program=/bin/bash big.txt", "sort '-o' /tmp/pwn PLAN.md",
        'sort "-o" /tmp/pwn PLAN.md', "sort -'o' /tmp/pwn PLAN.md",
        "sort --'output' /tmp/pwn PLAN.md", "yq '-i' .x=1 f.yaml",
        "git diff '--output=/tmp/pwn' HEAD~1 HEAD", "git log --'output'=/tmp/pwn -1",
        "git log --outp\\ut=/tmp/pwn -1", "git log 'https://evil.com/x'",
        "git grep -Otouch needle", "git grep -O touch needle", "git grep -O/bin/bash needle",
        "git grep --open-files-in-pager=touch needle", "git grep --open-files-in-pager touch needle",
        "git grep -O'touch /tmp/pwn' needle", 'git grep -O"touch /tmp/pwn" needle',
        "git grep --open-files-in-pager='touch ../x' needle",
        "git grep -n -O'touch /tmp/pwn' needle", "git grep -O'touch /tmp/pwn' -n needle",
        "git grep -Otouch needle | head", "uniq PLAN.md /home/x/.bashrc", "uniq in out",
        "uniq -c in out", "uniq -f 2 in out", "uniq -f2 in out", "uniq --skip-fields=2 in out",
        "uniq --skip-fields 2 in out", "uniq -- PLAN.md out", "uniq in out | head",
        "git symbolic-ref HEAD refs/heads/pwned",
        "git symbolic-ref refs/remotes/origin/HEAD refs/heads/x",
        "git symbolic-ref -m reason HEAD refs/heads/x",
        "git symbolic-ref --reason reason HEAD refs/heads/x",
        "git symbolic-ref -mreason HEAD refs/heads/x", "git symbolic-ref HEAD refs/heads/x | head",
        "git symbolic-ref --delete HEAD", "tree -o /tmp/listing.txt .", "tree -o/tmp/listing.txt .",
        "tree --output-file=/tmp/listing.txt .", "tree -o ~/.bashrc .",
        "less -o /tmp/lesslog.txt file", "less -O/tmp/lesslog.txt file",
        "less --log-file=/tmp/lesslog.txt file", "less --LOG-FILE=/tmp/lesslog.txt file",
        "bat --pager less file"]
        .map((cmd) => ({ cmd, expect: false })),
      // profile-extra corpus
      { cmd: "julia run.jl", extra: ["julia"], expect: true },
      { cmd: "julia s.jl | head", extra: ["julia"], expect: true },
      { cmd: "cd src && julia run.jl", extra: ["julia"], expect: true },
      { cmd: "grep x f | julia", extra: ["julia"], expect: true },
      { cmd: "julia run.jl && rm -rf /", extra: ["julia"], expect: false },
      { cmd: "julia run.jl; ls", extra: ["julia"], expect: false },
    ];
    for (const { cmd, extra, expect } of corpus) {
      assert.equal(
        isSafeCommand(cmd, extra),
        checkSafeCommand(cmd, extra).ok,
        `parity for ${JSON.stringify(cmd)}`,
      );
      assert.equal(checkSafeCommand(cmd, extra).ok, expect, `verdict for ${JSON.stringify(cmd)}`);
    }
  });
});

describe("profiles", () => {
  it("mergeProfiles deep-merges by name, later layers win per-field", () => {
    assert.equal(mergeProfiles(), undefined);
    assert.equal(mergeProfiles(undefined, undefined), undefined);
    const merged = mergeProfiles(
      { julia: { description: "Julia", bash: ["julia"], tools: ["kaimon"] } },
      { julia: { description: "Julia dev", writePaths: ["notebooks/"] }, other: { bash: ["x"] } },
    );
    assert.deepEqual(merged, {
      julia: {
        description: "Julia dev",
        bash: ["julia"],
        tools: ["kaimon"],
        writePaths: ["notebooks/"],
      },
      other: { bash: ["x"] },
    });
  });

  it("arrays replace rather than concat (project overrides global)", () => {
    const merged = mergeProfiles(
      { julia: { bash: ["julia", "juliaup"] } },
      { julia: { bash: ["julia"] } },
    );
    assert.deepEqual(merged?.julia?.bash, ["julia"]);
  });

  it("expandToolEntry matches exact names and *-suffix globs", () => {
    const available = new Set(["kaimon_run", "kaimon_eval", "read", "bash", "julia_run"]);
    assert.deepEqual(expandToolEntry("read", available), ["read"]);
    assert.deepEqual(expandToolEntry("kaimon*", available), ["kaimon_run", "kaimon_eval"]);
    assert.deepEqual(expandToolEntry("missing", available), []);
    assert.deepEqual(expandToolEntry("zzz*", available), []);
  });

  it("buildPlanModeTools adds profile tools filtered to available and reports unknown", () => {
    const available = new Set(["read", "bash", "kaimon_run"]);
    const { tools, unknown } = buildPlanModeTools(
      ["read", "bash"],
      { tools: ["kaimon_run", "kaimon_eval", "nope"] },
      available,
    );
    assert.deepEqual(tools, ["read", "bash", "kaimon_run"]);
    assert.deepEqual(unknown, ["kaimon_eval", "nope"]);
  });

  it("buildPlanModeTools without a profile returns the base unchanged", () => {
    const { tools, unknown } = buildPlanModeTools(["read"], undefined, new Set(["read"]));
    assert.deepEqual(tools, ["read"]);
    assert.deepEqual(unknown, []);
  });
});

describe("isAllowedWritePath", () => {
  const cwd = "/proj";
  const planFile = "/proj/PLAN.md";

  it("allows the plan file and profile writePaths", () => {
    assert.equal(isAllowedWritePath(cwd, planFile, undefined, "PLAN.md"), true);
    assert.equal(isAllowedWritePath(cwd, planFile, undefined, "@PLAN.md"), true);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "notebooks/a.jl"), true);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "notebooks/sub/b.jl"), true);
  });

  it("blocks everything outside the allowed set", () => {
    assert.equal(isAllowedWritePath(cwd, planFile, undefined, "src/a.ts"), false);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "src/a.ts"), false);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], ""), false);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "/etc/passwd"), false);
  });

  it("rejects .. escapes that resolve outside the allowed set", () => {
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "notebooks/../../etc/passwd"), false);
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "../PLAN.md"), false);
    // .. that stays inside an allowed path resolves back to it and is fine
    assert.equal(isAllowedWritePath(cwd, planFile, ["notebooks/"], "notebooks/x/../a.jl"), true);
  });
});

describe("config helpers", () => {
  it("getPlanFilePath defaults to PLAN.md in cwd", () => {
    assert.equal(getPlanFilePath("/proj", {}), "/proj/PLAN.md");
    assert.equal(getPlanFilePath("/proj", { planFile: "docs/plan.md" }), "/proj/docs/plan.md");
    assert.equal(getPlanFilePath("/proj", { planFile: "/abs/plan.md" }), "/abs/plan.md");
  });
});

describe("resolvePlanFileIn", () => {
  it("accepts a plain relative name inside cwd", () => {
    const proj = join(mkdtempSync(join(tmpdir(), "rpf-in-")), "proj");
    mkdirSync(proj, { recursive: true });
    assert.equal(resolvePlanFileIn(proj, "PLAN2.md"), join(proj, "PLAN2.md"));
    assert.equal(resolvePlanFileIn(proj, "docs/plan.md"), join(proj, "docs/plan.md"));
  });

  it("rejects an empty name", () => {
    assert.equal(resolvePlanFileIn("/proj", ""), null);
    assert.equal(resolvePlanFileIn("/proj", "   "), null);
  });

  it("rejects a .. escape that resolves outside cwd", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "rpf-out-"));
    const proj = join(sandbox, "proj");
    mkdirSync(proj, { recursive: true });
    assert.equal(resolvePlanFileIn(proj, "../plan.md"), null);
    assert.equal(resolvePlanFileIn(proj, "../../plan.md"), null);
  });

  it("rejects an absolute path outside cwd", () => {
    assert.equal(resolvePlanFileIn("/proj", "/etc/plan.md"), null);
    assert.equal(resolvePlanFileIn("/proj", "/tmp/plan.md"), null);
  });

  it("rejects an escape via a symlinked subdir (R9 parity)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "rpf-sym-"));
    const proj = join(sandbox, "proj");
    const outside = join(sandbox, "outside");
    mkdirSync(proj, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(proj, "link"));
    // link resolves to ../outside, outside proj → rejected
    assert.equal(resolvePlanFileIn(proj, "link/plan.md"), null);
  });

  it("accepts a name whose .. resolves back inside cwd", () => {
    const proj = join(mkdtempSync(join(tmpdir(), "rpf-in-")), "proj");
    mkdirSync(join(proj, "sub"), { recursive: true });
    assert.equal(resolvePlanFileIn(proj, "sub/../plan.md"), join(proj, "plan.md"));
  });
});

describe("buildWidgetLines", () => {
  const longPlan = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");

  it("renders exactly one status line (never exceeds the TUI cap)", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", "Alt+O", noopTheme);
    assert.equal(lines.length, 1);
    assert.ok(lines.length <= TUI_WIDGET_LINE_CAP);
  });

  it("status line shows plan path, line count, and the toggle key", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", "Alt+O", noopTheme);
    assert.match(lines[0], /📋 Plan/);
    assert.match(lines[0], /\/proj\/PLAN\.md/);
    assert.match(lines[0], /40 lines/);
    assert.match(lines[0], /Alt\+O/);
  });

  it("handles empty content", () => {
    const lines = buildWidgetLines("", "/p/PLAN.md", "Alt+O", noopTheme);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\/p\/PLAN\.md/);
  });
});

describe("describePlanModeBashRules", () => {
  it("lists allowed heads and git subcommands from the live constants", () => {
    const rules = describePlanModeBashRules();
    const lines = rules.split("\n");
    // heads line (index 1) is the comma-separated allowlist
    assert.match(lines[1], /\bls\b/);
    assert.match(lines[1], /\bgrep\b/);
    assert.match(lines[1], /\bfind\b/);
    const gitLine = lines.find((l) => l.startsWith("git subcommands:")) ?? "";
    assert.match(gitLine, /\bstatus\b/);
    assert.match(gitLine, /\bdiff\b/);
    assert.doesNotMatch(gitLine, /\bpush\b/);
    assert.doesNotMatch(gitLine, /\bls-remote\b/);
  });

  it("states the deny rules for the agent", () => {
    const rules = describePlanModeBashRules();
    assert.match(rules, /--output/);
    assert.match(rules, /-exec/);
    assert.match(rules, /~/);
    assert.match(rules, /#/);
    assert.match(rules, /;/);
    assert.match(rules, /ls-remote is not allowed/);
    assert.match(rules, /NEVER ALLOWED/);
  });

  it("never presents denied heads as allowed", () => {
    const rules = describePlanModeBashRules();
    const headsLine = rules.split("\n")[1];
    assert.doesNotMatch(headsLine, /\b(rm|curl|ssh|sudo|touch|mkdir|sed|awk|xargs|env|wget)\b/);
    // ...but the deny section names them as examples of what is excluded
    assert.match(rules, /\brm\b/);
    assert.match(rules, /\bcurl\b/);
  });

  it("includes profile bash additions", () => {
    const rules = describePlanModeBashRules(["julia", "julia", "pluto"]);
    assert.match(rules, /Profile bash additions: julia, pluto/);
    const none = describePlanModeBashRules([]);
    assert.doesNotMatch(none, /Profile bash additions/);
  });
});

describe("describeUnsafePlanMode", () => {
  it("states that every restriction is disabled", () => {
    const text = describeUnsafePlanMode();
    assert.match(text, /all plan-mode restrictions are DISABLED/);
    assert.match(text, /Every tool is available/);
    assert.match(text, /bash runs ANY command/);
    assert.match(text, /edit\/write work on ANY path/);
  });

  it("enumerates no allowlist or deny rules (there are none in unsafe mode)", () => {
    const text = describeUnsafePlanMode();
    assert.ok(!text.includes("SAFE BASH HEADS"));
    assert.ok(!text.includes("DENIED EVEN ON ALLOWED HEADS"));
    assert.ok(!text.includes("git subcommands"));
    assert.ok(!text.includes("NEVER ALLOWED"));
  });

  it("puts staying in the planning loop on the agent (the gate will not stop it)", () => {
    const text = describeUnsafePlanMode();
    assert.match(text, /The gate will NOT stop you/);
    assert.match(text, /the plan is the deliverable, not implementation/);
  });
});

describe("theme builders", () => {
  /** Theme stub: colors and styles as bracket tags, so assertions stay plain-text. */
  const themeStub = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (t: string) => `[b:${t}]`,
    italic: (t: string) => `[i:${t}]`,
    underline: (t: string) => `[u:${t}]`,
    strikethrough: (t: string) => `[s:${t}]`,
  } as unknown as Theme;

  it("buildMarkdownTheme maps every markdown element to its md* color/style", () => {
    const md = buildMarkdownTheme(themeStub);
    assert.equal(md.heading("H"), "[mdHeading:H]");
    assert.equal(md.link("L"), "[mdLink:L]");
    assert.equal(md.linkUrl("U"), "[mdLinkUrl:U]");
    assert.equal(md.code("C"), "[mdCode:C]");
    assert.equal(md.codeBlock("B"), "[mdCodeBlock:B]");
    assert.equal(md.codeBlockBorder("X"), "[mdCodeBlockBorder:X]");
    assert.equal(md.quote("Q"), "[mdQuote:Q]");
    assert.equal(md.quoteBorder("Z"), "[mdQuoteBorder:Z]");
    assert.equal(md.hr("-"), "[mdHr:-]");
    assert.equal(md.listBullet("•"), "[mdListBullet:•]");
    assert.equal(md.bold("x"), "[b:x]");
    assert.equal(md.italic("x"), "[i:x]");
    assert.equal(md.underline("x"), "[u:x]");
    assert.equal(md.strikethrough("x"), "[s:x]");
  });

  it("buildEditorTheme mirrors pi's editor theme", () => {
    const ed = buildEditorTheme(themeStub);
    assert.equal(ed.borderColor("─"), "[borderMuted:─]");
    assert.equal(ed.selectList.selectedPrefix(">"), "[accent:>]");
    assert.equal(ed.selectList.selectedText("t"), "[accent:t]");
    assert.equal(ed.selectList.description("d"), "[muted:d]");
    assert.equal(ed.selectList.scrollInfo("s"), "[muted:s]");
    assert.equal(ed.selectList.noMatch("n"), "[muted:n]");
  });
});
