import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildEditorTheme,
  buildMarkdownTheme,
  buildPlanModeTools,
  buildWidgetLines,
  cleanQueries,
  cleanUrl,
  expandToolEntry,
  getCollapsedLines,
  getPlanFilePath,
  isAllowedWritePath,
  isSafeCommand,
  mergeProfiles,
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

  it("renders exactly one status line (never exceeds the TUI cap)", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", 5, "Alt+O", noopTheme);
    assert.equal(lines.length, 1);
    assert.ok(lines.length <= TUI_WIDGET_LINE_CAP);
  });

  it("status line shows plan path, line count, and the toggle key", () => {
    const lines = buildWidgetLines(longPlan, "/proj/PLAN.md", 5, "Alt+O", noopTheme);
    assert.match(lines[0], /📋 Plan/);
    assert.match(lines[0], /\/proj\/PLAN\.md/);
    assert.match(lines[0], /40 lines/);
    assert.match(lines[0], /Alt\+O/);
  });

  it("ignores collapsedLines (no body preview anymore)", () => {
    const with1 = buildWidgetLines(longPlan, "/p", 1, "Alt+O", noopTheme);
    const with8 = buildWidgetLines(longPlan, "/p", 8, "Alt+O", noopTheme);
    assert.deepEqual(with1, with8);
    assert.equal(with1.length, 1);
  });

  it("handles empty content", () => {
    const lines = buildWidgetLines("", "/p/PLAN.md", 5, "Alt+O", noopTheme);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\/p\/PLAN\.md/);
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
