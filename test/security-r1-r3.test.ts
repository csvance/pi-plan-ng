import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSafeCommand } from "../utils.ts";

describe("security: R1 rg --pre RCE, R2 sort --compress-program RCE, R3 quoted-flag evasions", () => {
  it("blocks rg --pre (executes every searched file through a command) (R1)", () => {
    const blocked = [
      "rg --pre /bin/bash needle PLAN.md",
      "rg --pre=bash needle PLAN.md",
      "rg --pre='cat' needle PLAN.md",
      "rg '--pre' /bin/bash needle PLAN.md",
      'rg "--pre" /bin/bash needle PLAN.md',
      "rg --p're' /bin/bash needle PLAN.md",
      "rg --pre-glob '*.md' --pre /bin/bash needle PLAN.md",
      // brace-duplicate forms expand to two valid --pre=/bin/bash copies (verified live)
      "rg --p{re,re}=/bin/bash needle PLAN.md",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("blocks rg --pager (defense-in-depth; spawns a pager command on a tty) (R1)", () => {
    assert.equal(isSafeCommand("rg --pager less needle PLAN.md"), false);
    assert.equal(isSafeCommand("rg --pager='less' needle PLAN.md"), false);
  });

  it("blocks sort --compress-program (executes sorted chunks through a command) (R2)", () => {
    const blocked = [
      "sort --compress-program=/bin/bash big.txt",
      "sort --compress-program /bin/bash big.txt",
      "sort '--compress-program'=/bin/bash big.txt",
      'sort "--compress-program=/bin/bash" big.txt',
      // brace-duplicate forms expand to two valid --compress-program=/bin/bash copies (verified live)
      "sort --compress-{,}program=/bin/bash big.txt",
      "sort --{compress-,compress-}program=/bin/bash big.txt",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("blocks quoted/escaped flag evasions of the deny table (R3)", () => {
    const blocked = [
      "sort '-o' /tmp/pwn PLAN.md",
      'sort "-o" /tmp/pwn PLAN.md',
      "sort -'o' /tmp/pwn PLAN.md",
      "sort --'output' /tmp/pwn PLAN.md",
      "yq '-i' .x=1 f.yaml",
      "git diff '--output=/tmp/pwn' HEAD~1 HEAD",
      "git log --'output'=/tmp/pwn -1",
      "git log --outp\\ut=/tmp/pwn -1",
      // R10: GIT_REMOTE must be checked on dequoted tokens too
      "git log 'https://evil.com/x'",
    ];
    for (const cmd of blocked) {
      assert.equal(isSafeCommand(cmd), false, `expected blocked: ${cmd}`);
    }
  });

  it("keeps innocuous rg/sort/git usage allowed", () => {
    assert.equal(isSafeCommand("rg -n needle PLAN.md"), true);
    assert.equal(isSafeCommand("rg --pretty needle PLAN.md"), true);
    assert.equal(isSafeCommand("rg --no-line-number needle PLAN.md"), true);
    // --pre-glob alone is inert (only meaningful together with --pre, which is denied)
    assert.equal(isSafeCommand("rg --pre-glob '*.md' needle PLAN.md"), true);
    assert.equal(isSafeCommand("rg -g '*.md' needle ."), true);
    assert.equal(isSafeCommand("sort big.txt"), true);
    assert.equal(isSafeCommand("sort -n -u -S 64K big.txt"), true);
    assert.equal(isSafeCommand("git status"), true);
    assert.equal(isSafeCommand("git diff HEAD~1 HEAD"), true);
  });
});
