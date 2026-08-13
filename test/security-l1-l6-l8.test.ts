import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSafeCommand } from "../utils.ts";

describe("security regressions: L1 find-flag obfuscation, L6 comments, L8 trailing backslash", () => {
  it("blocks obfuscated find write/exec flags (L1)", () => {
    const bad = [
      "find . '-delete'",
      'find . "-exec" rm -rf {} \\;',
      "find . -\\delete",
      "find . -e'xec' rm {} \\;",
      "find . -{d,d}elete",
      'find . "-execdir" id \\;',
      'find . "-ok" rm {} \\;',
      'find . "-fprint" /tmp/x',
      "find . -delete",
      "find . -exec rm {} ;",
    ];
    for (const cmd of bad) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("rejects a command ending in a lone backslash (L8)", () => {
    assert.equal(isSafeCommand("ls \\"), false);
  });

  it("treats a word-start # as a comment and truncates (L6)", () => {
    assert.equal(isSafeCommand("ls # rm -rf /"), true);
    assert.equal(isSafeCommand("find . -delete # comment"), false);
    assert.equal(isSafeCommand("echo a#b"), true);
  });

  it("still allows plain read-only find and quoted metacharacters", () => {
    const ok = [
      "find . -name '*.ts'",
      "find . -name x",
      "grep 'a|b' file",
      "cd src && find . -name x | head -3",
      "find . -name '{x}'",
    ];
    for (const cmd of ok) {
      assert.equal(isSafeCommand(cmd), true, `expected allowed: ${cmd}`);
    }
  });
});
