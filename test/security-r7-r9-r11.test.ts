import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeProfileGrants, isSafeCommand, loadConfig } from "../utils.ts";

describe("security: R9 untrusted project config", () => {
  it("drops a project planFile that resolves outside the project (R9)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r9-outside-"));
    const proj = join(sandbox, "proj");
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(proj, ".pi", "plan-mode.json"), JSON.stringify({ planFile: "../outside.md" }));

    // Compare against a dir with no project config: only a global config
    // (user-owned, trusted) may set planFile, so whatever it contributes
    // must survive unchanged.
    const baseline = loadConfig(join(sandbox, "empty"));
    const config = loadConfig(proj);
    assert.equal(config.planFile, baseline.planFile, "outside planFile must not win");
  });

  it("rejects an absolute project planFile (AUDIT repro)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r9-abs-"));
    const proj = join(sandbox, "proj");
    mkdirSync(join(proj, ".pi"), { recursive: true });
    const victim = join(sandbox, "victim.txt");
    writeFileSync(join(proj, ".pi", "plan-mode.json"), JSON.stringify({ planFile: victim }));

    const baseline = loadConfig(join(sandbox, "empty"));
    const config = loadConfig(proj);
    assert.equal(config.planFile, baseline.planFile, "absolute outside planFile must be dropped");
  });

  it("rejects a project planFile that escapes via a symlinked subdir (R9)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r9-symlink-"));
    const proj = join(sandbox, "proj");
    mkdirSync(join(proj, ".pi"), { recursive: true });
    mkdirSync(join(sandbox, "outside"), { recursive: true });
    symlinkSync(join(sandbox, "outside"), join(proj, "link"), "dir");
    writeFileSync(join(proj, ".pi", "plan-mode.json"), JSON.stringify({ planFile: "link/plan.md" }));

    const baseline = loadConfig(join(sandbox, "empty"));
    const config = loadConfig(proj);
    assert.equal(config.planFile, baseline.planFile);
  });

  it("keeps a project planFile inside the project (R9)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r9-inside-"));
    const proj = join(sandbox, "proj");
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(proj, ".pi", "plan-mode.json"), JSON.stringify({ planFile: "docs/plan.md" }));

    const config = loadConfig(proj);
    assert.equal(config.planFile, "docs/plan.md");
  });

  it("describeProfileGrants lists the actual grants (R9)", () => {
    assert.deepEqual(
      describeProfileGrants({ bash: ["julia"], tools: ["kaimon*"], writePaths: ["out/"] }),
      ["bash: julia", "tools: kaimon*", "write paths: out/"],
    );
    assert.deepEqual(describeProfileGrants({ bash: ["a", "a"], tools: ["t", "t"] }), ["bash: a", "tools: t"]);
    assert.deepEqual(describeProfileGrants({ description: "no grants" }), []);
  });
});

describe("security: R7 symbolic-ref write form, R8 tree -o, R11 tty-dependent flags", () => {
  it("blocks the git symbolic-ref update and delete forms (R7)", () => {
    const blocked = [
      "git symbolic-ref HEAD refs/heads/pwned",
      "git symbolic-ref refs/remotes/origin/HEAD refs/heads/x",
      "git symbolic-ref -m reason HEAD refs/heads/x",
      "git symbolic-ref --reason reason HEAD refs/heads/x",
      "git symbolic-ref -mreason HEAD refs/heads/x",
      "git symbolic-ref HEAD refs/heads/x | head",
      "git symbolic-ref --delete HEAD",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps the read-only symbolic-ref query form allowed (R7)", () => {
    assert.equal(isSafeCommand("git symbolic-ref HEAD"), true);
    assert.equal(isSafeCommand("git symbolic-ref --short HEAD"), true);
    assert.equal(isSafeCommand("git symbolic-ref -q HEAD"), true);
    assert.equal(isSafeCommand("git symbolic-ref -q --short HEAD"), true);
  });

  it("blocks tree -o / --output-file (writes the listing to a file) (R8)", () => {
    const blocked = [
      "tree -o /tmp/listing.txt .",
      "tree -o/tmp/listing.txt .",
      "tree --output-file=/tmp/listing.txt .",
      "tree -o ~/.bashrc .",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps harmless tree forms allowed (R8)", () => {
    assert.equal(isSafeCommand("tree"), true);
    assert.equal(isSafeCommand("tree -L 2 ."), true);
    assert.equal(isSafeCommand("tree -a -d"), true);
    assert.equal(isSafeCommand("tree -J"), true);
  });

  it("blocks tty-dependent write/exec flags as defense-in-depth (R11)", () => {
    const blocked = [
      "less -o /tmp/lesslog.txt file",
      "less -O/tmp/lesslog.txt file",
      "less --log-file=/tmp/lesslog.txt file",
      "less --LOG-FILE=/tmp/lesslog.txt file",
      "bat --pager less file",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps harmless less/bat forms allowed (R11)", () => {
    assert.equal(isSafeCommand("less file"), true);
    assert.equal(isSafeCommand("less -N file"), true);
    assert.equal(isSafeCommand("bat file"), true);
    assert.equal(isSafeCommand("bat -n file"), true);
    assert.equal(isSafeCommand("bat --paging=always file"), true);
  });
});
