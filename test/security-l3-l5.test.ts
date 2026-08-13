import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isAllowedWritePath } from "../utils.ts";

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
