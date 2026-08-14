import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bashBlockReason } from "../utils.ts";

/**
 * bashBlockReason is what the plan-mode gate returns as `block.reason` —
 * the text the model actually sees when a bash command is blocked. These
 * tests pin the format: a label prefix, a one-line specific explanation,
 * the blocked command, a pointer to the injected BASH RULES block, and
 * the escape hatch. Safe commands must never produce a reason.
 */
describe("bashBlockReason (the reason the agent sees)", () => {
  it("returns null for safe commands", () => {
    assert.equal(bashBlockReason("ls"), null);
    assert.equal(bashBlockReason("git status"), null);
    assert.equal(bashBlockReason("cd src && grep x f | head -3"), null);
    assert.equal(bashBlockReason("julia run.jl", ["julia"]), null);
    // an unquoted word-start # truncates — the command is read-only and safe
    assert.equal(bashBlockReason("ls # rm -rf /"), null);
  });

  it("prepends the [label] prefix when given", () => {
    const reason = bashBlockReason("rm -rf /", undefined, "plan mode (julia)");
    assert.ok(reason?.startsWith("[plan mode (julia)] "), reason ?? "null");
  });

  it("includes the specific explanation, the blocked command, the rules pointer, and the escape hatch", () => {
    const reason = bashBlockReason("sort -o /tmp/pwn PLAN.md");
    assert.ok(reason, "expected a reason for sort -o");
    assert.match(reason, /^\[?[^\n]*sort -o writes output to a file/);
    assert.ok(reason.includes("Blocked: sort -o /tmp/pwn PLAN.md"));
    assert.ok(reason.includes("Full rules: see BASH RULES in your plan-mode instructions."));
    assert.ok(reason.includes("Run /plan to leave plan mode, or /plan go to execute the plan with full access."));
  });

  it("action-head reasons mention /plan go and read-only framing", () => {
    const reason = bashBlockReason("rm -rf /") ?? "";
    assert.match(reason, /rm is not allowlisted/);
    assert.match(reason, /\/plan go/);
    assert.match(reason, /read-only/);
  });

  it("git write-subcommand reasons list the allowed subcommands derived from SAFE_GIT_SUBCOMMANDS", () => {
    const reason = bashBlockReason("git push origin main") ?? "";
    assert.match(reason, /git push is not an allowed/);
    // derived from the live constant — representative read-only subcommands
    assert.match(reason, /\bstatus\b/);
    assert.match(reason, /\blog\b/);
    assert.match(reason, /\bdiff\b/);
    // the allowed list itself never contains write subcommands
    const allowedLine = reason.split("\n")[0].split("allowed:")[1] ?? "";
    assert.doesNotMatch(allowedLine, /\b(checkout|stash|fetch|add|commit|push|merge|rebase)\b/);
  });

  it("quoted-head reasons say to unquote", () => {
    const reason = bashBlockReason("'ls'") ?? "";
    assert.match(reason, /quoted command name/);
    assert.match(reason, /unquote/);
  });

  it("prefixes the failing segment only for multi-segment commands", () => {
    const multi = bashBlockReason("cd src && rm -rf /") ?? "";
    assert.ok(multi.includes('in segment 2 ("rm -rf /")'), multi);
    const single = bashBlockReason("rm -rf /") ?? "";
    assert.ok(!single.includes("in segment"), single);
  });

  it("comment-caused empty segments explain the # truncation", () => {
    const reason = bashBlockReason("ls && # note") ?? "";
    assert.match(reason, /empty segment/);
    assert.match(reason, /#/);
    assert.match(reason, /comment/);
    const plain = bashBlockReason("cd x &&") ?? "";
    assert.match(plain, /empty segment after "&&"/);
    assert.doesNotMatch(plain, /comment/);
  });

  it("multi-line/blocked reason is one explanation line followed by the standard footer", () => {
    const reason = bashBlockReason("cat $(ls)") ?? "";
    const lines = reason.split("\n");
    assert.equal(lines.length, 4, JSON.stringify(reason));
    assert.match(lines[0], /\$|unquoted/);
    assert.ok(lines[1].startsWith("Blocked: "));
    assert.ok(lines[2].startsWith("Full rules: "));
    assert.ok(lines[3].startsWith("Run /plan "));
  });
});
