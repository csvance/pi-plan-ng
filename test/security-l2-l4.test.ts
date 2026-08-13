import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSafeCommand } from "../utils.ts";

describe("security: L2 write-capable flags, L7 tilde pass-through, L4 git ls-remote", () => {
  it("blocks write-capable flags on allowlisted commands (L2)", () => {
    const blocked = [
      "sort -o /tmp/x /tmp/in",
      "sort -o=/tmp/x",
      "sort -o/tmp/x",
      "sort --output /tmp/x",
      "sort --output=/tmp/x",
      'yq -i ".x = 1" f.yaml',
      "yq -i=true",
      'yq --inplace ".x = 1" f.yaml',
      "yq --inplace",
      "git diff --output=/tmp/x HEAD~1 HEAD",
      "git log --output=/tmp/x -1",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("still allows harmless forms of the same commands (L2)", () => {
    assert.equal(isSafeCommand("sort /tmp/in"), true);
    assert.equal(isSafeCommand("yq .x f.yaml"), true);
    assert.equal(isSafeCommand("git status"), true);
    assert.equal(isSafeCommand("git diff HEAD~1 HEAD"), true);
    assert.equal(isSafeCommand("git diff --output-indicator-new=x HEAD~1 HEAD"), true);
  });

  it("blocks git ls-remote and remote-looking arguments (L4)", () => {
    assert.equal(isSafeCommand("git ls-remote origin"), false);
    assert.equal(isSafeCommand("git ls-remote"), false);
    assert.equal(isSafeCommand("git diff https://example.com/x"), false);
    assert.equal(isSafeCommand("git log git@github.com:x/y"), false);
  });

  it("blocks unquoted word-initial tilde (L7)", () => {
    assert.equal(isSafeCommand("sort -o ~/.ssh/authorized_keys /dev/null"), false);
    assert.equal(isSafeCommand("cat ~/x"), false);
    assert.equal(isSafeCommand("cd ~"), false);
  });

  it("keeps quoted tilde literal (L7)", () => {
    assert.equal(isSafeCommand("ls '~'"), true);
  });

  it("blocks unsafe segments anywhere in a composition", () => {
    assert.equal(isSafeCommand("cd src && sort x | head"), true);
    assert.equal(isSafeCommand("sort -o /tmp/x f | head"), false);
  });
});
