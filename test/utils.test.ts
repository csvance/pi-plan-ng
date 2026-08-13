import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildWidgetLines,
  cleanQueries,
  cleanUrl,
  getCollapsedLines,
  getPlanFilePath,
  isSafeCommand,
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

  it("blocks shell metacharacters (chaining, pipes, substitution, redirection)", () => {
    const bad = [
      "ls; rm -rf /",
      "ls && pwd",
      "ls || echo hi",
      "ls | wc -l",
      "cat $(ls)",
      "cat `ls`",
      "echo < /etc/passwd",
      "echo > /tmp/x",
      "(ls)",
      "ls\nrm -rf /",
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
});

describe("config helpers", () => {
  it("getPlanFilePath defaults to PLAN.md in cwd", () => {
    assert.equal(getPlanFilePath("/proj", {}), "/proj/PLAN.md");
    assert.equal(getPlanFilePath("/proj", { planFile: "docs/plan.md" }), "/proj/docs/plan.md");
    assert.equal(getPlanFilePath("/proj", { planFile: "/abs/plan.md" }), "/abs/plan.md");
  });

  it("getCollapsedLines defaults to 5 and clamps invalid values", () => {
    assert.equal(getCollapsedLines({}), 5);
    assert.equal(getCollapsedLines({ collapsedLines: 3 }), 3);
    assert.equal(getCollapsedLines({ collapsedLines: 0 }), 5);
    assert.equal(getCollapsedLines({ collapsedLines: NaN }), 5);
    assert.equal(getCollapsedLines({ collapsedLines: 2.9 }), 2);
  });
});

describe("buildWidgetLines", () => {
  const longPlan = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");

  it("never exceeds the TUI widget line cap", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", 5, "Alt+O", noopTheme);
    assert.ok(lines.length <= TUI_WIDGET_LINE_CAP, `got ${lines.length} lines`);
    assert.ok(lines.length >= 2);
  });

  it("includes a header and a hint pointing at the full-screen view", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", 5, "Alt+O", noopTheme);
    assert.match(lines[0], /📋 Plan/);
    assert.match(lines[0], /40 lines/);
    assert.match(lines[lines.length - 1], /Alt\+O/);
    assert.match(lines[lines.length - 1], /more line/);
  });

  it("renders short plans fully without a hint", () => {
    const lines = buildWidgetLines("# Hi", "/proj/PLAN.md", 5, "Alt+O", noopTheme);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], "  # Hi");
  });

  it("respects collapsedLines within the cap", () => {
    const with1 = buildWidgetLines(longPlan, "/p", 1, "Alt+O", noopTheme);
    const with8 = buildWidgetLines(longPlan, "/p", 8, "Alt+O", noopTheme);
    assert.ok(with1.length < with8.length);
    assert.ok(with8.length <= TUI_WIDGET_LINE_CAP);
  });

  it("handles empty content", () => {
    const lines = buildWidgetLines("", "/p/PLAN.md", 5, "Alt+O", noopTheme);
    assert.ok(lines.length >= 1);
    assert.ok(lines.length <= TUI_WIDGET_LINE_CAP);
  });
});

describe("search result parsing helpers", () => {
  it("cleanQueries drops ws_call_id noise entries", () => {
    assert.equal(cleanQueries("nope"), undefined);
    assert.deepEqual(cleanQueries(["a", "b"]), ["a", "b"]);
    assert.deepEqual(cleanQueries(["a", "ws_call_id=123"]), ["a"]);
    assert.equal(cleanQueries(["ws_call_id=123"]), undefined);
  });

  it("cleanUrl strips the ws_call_id fragment", () => {
    assert.equal(cleanUrl("https://x.com/a#ws_call_id=9"), "https://x.com/a");
    assert.equal(cleanUrl("https://x.com"), "https://x.com");
    assert.equal(cleanUrl(42), undefined);
  });
});
