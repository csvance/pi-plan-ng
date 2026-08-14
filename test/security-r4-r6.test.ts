import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSafeCommand } from "../utils.ts";

describe("security: R4 git grep -O pager exec, R5 uniq positional write, R6 dangling symlink escape", () => {
  it("blocks git grep -O / --open-files-in-pager (arbitrary pager command) (R4)", () => {
    const blocked = [
      "git grep -Otouch needle",
      "git grep -O touch needle",
      "git grep -O/bin/bash needle",
      "git grep --open-files-in-pager=touch needle",
      "git grep --open-files-in-pager touch needle",
      // pager command smuggled inside the word via quoting (verified live in git)
      "git grep -O'touch /tmp/pwn' needle",
      'git grep -O"touch /tmp/pwn" needle',
      "git grep --open-files-in-pager='touch ../x' needle",
      // combined with other flags, in any position
      "git grep -n -O'touch /tmp/pwn' needle",
      "git grep -O'touch /tmp/pwn' -n needle",
      // also blocked mid-composition
      "git grep -Otouch needle | head",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps harmless git grep and diff -O forms allowed (R4)", () => {
    assert.equal(isSafeCommand("git grep needle"), true);
    assert.equal(isSafeCommand("git grep -n needle"), true);
    assert.equal(isSafeCommand("git grep -o needle"), true);
    assert.equal(isSafeCommand("git grep -e 'pat' -- '*.md'"), true);
    // git diff -O<orderfile> is read-only (diff ordering), not a pager
    assert.equal(isSafeCommand("git diff -Oorderfile HEAD~1 HEAD"), true);
    assert.equal(isSafeCommand("git grep needle | head"), true);
  });

  it("blocks uniq with a second positional output file (R5)", () => {
    const blocked = [
      "uniq PLAN.md /home/x/.bashrc",
      "uniq in out",
      "uniq -c in out",
      "uniq -f 2 in out",
      "uniq -f2 in out",
      "uniq --skip-fields=2 in out",
      "uniq --skip-fields 2 in out",
      "uniq -- PLAN.md out",
      "uniq in out | head",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps read-only uniq forms allowed (R5)", () => {
    assert.equal(isSafeCommand("uniq"), true);
    assert.equal(isSafeCommand("uniq file"), true);
    assert.equal(isSafeCommand("uniq -c file"), true);
    assert.equal(isSafeCommand("uniq -u -d file"), true);
    assert.equal(isSafeCommand("uniq -f 2 file"), true);
    assert.equal(isSafeCommand("uniq -f2 file"), true);
    assert.equal(isSafeCommand("uniq --skip-fields=2 file"), true);
    assert.equal(isSafeCommand("uniq -i file"), true);
    assert.equal(isSafeCommand("uniq file | head"), true);
  });
});
