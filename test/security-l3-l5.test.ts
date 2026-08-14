import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isAllowedWritePath, isSymlink } from "../utils.ts";

/**
 * L3 regression tests: isAllowedWritePath must resolve symlinks before
 * comparing, so a symlink inside an allowed directory (or a symlinked
 * PLAN.md) cannot be used to escape the allowed write set. Real fixtures
 * are built in a per-test mkdtemp sandbox under /tmp; never in the repo.
 */
describe("isAllowedWritePath symlink escapes (L3)", () => {
  it("rejects a symlink inside an allowed dir that points out of the tree", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-dir-escape-"));
    const root = join(sandbox, "proj");
    const outside = join(sandbox, "outside");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "notebooks", "leak"), "dir");

    const planFile = join(root, "PLAN.md");
    assert.equal(
      isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/leak/secret.txt"),
      false,
    );
  });

  it("rejects a PLAN.md that is itself a symlink to an outside file", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-plan-symlink-"));
    const root = join(sandbox, "proj");
    mkdirSync(root, { recursive: true });
    const outsideFile = join(sandbox, "outside-plan.md");
    writeFileSync(outsideFile, "hello");
    symlinkSync(outsideFile, join(root, "PLAN.md"), "file");

    assert.equal(
      isAllowedWritePath(root, join(root, "PLAN.md"), undefined, "PLAN.md"),
      false,
    );
  });

  it("allows a plain file inside an allowed dir", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-plain-file-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    writeFileSync(join(root, "notebooks", "a.jl"), "x");
    const planFile = join(root, "PLAN.md");

    assert.equal(isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/a.jl"), true);
  });

  it("allows a non-existent path inside an allowed dir (lexical fallback)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-non-existent-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    const planFile = join(root, "PLAN.md");

    assert.equal(isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/new.jl"), true);
  });

  it("rejects a .. escape that resolves outside the allowed set", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-dotdot-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    writeFileSync(join(dirname(root), "escape.txt"), "x");
    const planFile = join(root, "PLAN.md");

    assert.equal(
      isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/../../escape.txt"),
      false,
    );
  });

  it("allows a writePaths base that is itself a symlink pointing INTO the tree", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "l3-base-symlink-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    symlinkSync(join(root, "notebooks"), join(root, "linkbase"), "dir");
    const planFile = join(root, "PLAN.md");

    assert.equal(isAllowedWritePath(root, planFile, ["linkbase/"], "linkbase/x.txt"), true);
  });
});

/**
 * R6 regression tests: a *dangling* symlink (target does not exist) must not
 * defeat the canonicalization — realpath fails on it and the lexical fallback
 * would compare the link's own path (inside the allowed set) while
 * writeFileSync follows the link and creates the target outside it.
 */
describe("isAllowedWritePath dangling symlink escapes (R6)", () => {
  it("rejects a dangling symlink inside an allowed dir that points out of the tree", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r6-dangling-dir-"));
    const root = join(sandbox, "proj");
    const outside = join(root, "outside");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync("../outside/pwned.md", join(root, "notebooks", "leak.md"), "file");

    const planFile = join(root, "PLAN.md");
    assert.equal(
      isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/leak.md"),
      false,
      "writeFileSync would follow the dangling link and create ../outside/pwned.md",
    );
  });

  it("rejects a dangling symlink as the plan file", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r6-dangling-plan-"));
    const root = join(sandbox, "proj");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(sandbox, "outside"), { recursive: true });
    symlinkSync("../outside/stolen-plan.md", join(root, "PLAN.md"), "file");

    assert.equal(
      isAllowedWritePath(root, join(root, "PLAN.md"), undefined, "PLAN.md"),
      false,
      "writeFileSync would follow the dangling link and create ../outside/stolen-plan.md",
    );
  });

  it("rejects a write through a dangling symlink in an intermediate component", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r6-dangling-mid-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    symlinkSync("../outside/dir", join(root, "notebooks", "leak"), "dir");

    const planFile = join(root, "PLAN.md");
    assert.equal(
      isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/leak/sub/file.txt"),
      false,
      "writeFileSync would follow the dangling dir link and create ../outside/dir/sub/file.txt",
    );
  });

  it("still allows a plain non-existent path (lexical fallback preserved)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r6-lexical-ok-"));
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "notebooks"), { recursive: true });
    const planFile = join(root, "PLAN.md");

    assert.equal(isAllowedWritePath(root, planFile, ["notebooks/"], "notebooks/new.jl"), true);
  });

  it("isSymlink detects dangling links and ignores missing paths", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "r6-issymlink-"));
    const root = join(sandbox, "proj");
    mkdirSync(root, { recursive: true });
    symlinkSync("../nowhere.md", join(root, "dangling.md"), "file");
    writeFileSync(join(root, "plain.md"), "x");

    assert.equal(isSymlink(join(root, "dangling.md")), true);
    assert.equal(isSymlink(join(root, "plain.md")), false);
    assert.equal(isSymlink(join(root, "missing.md")), false);
  });
});
