import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  countChanges,
  diffPlanLines,
  hasChanges,
  type DiffLine,
  type DiffTheme,
} from "../diff.ts";

/** Fake theme that wraps colors/strikethrough in markers for assertions. */
const markerTheme: DiffTheme = {
  fg: (color, text) => `[${color}:${text}]`,
  strikethrough: (text) => `~ST~${text}`,
};

/** Helpers that assert a diff is entirely the given kinds. */
function kinds(lines: DiffLine[]): string[] {
  return lines.map((l) => l.kind);
}

describe("diffPlanLines", () => {
  it("marks a pure addition as a green 'added' line", () => {
    const lines = diffPlanLines("# Plan\n\na\n", "# Plan\n\na\nb\n", markerTheme);
    assert.deepEqual(kinds(lines), ["context", "context", "context", "added"]);
    const added = lines[lines.length - 1];
    assert.equal(added.text, "b");
    assert.ok(added.styled.includes("toolDiffAdded"), "added line colored green");
    assert.ok(!added.styled.includes("toolDiffRemoved"));
  });

  it("marks a pure removal as a red strikethrough 'removed' line", () => {
    const lines = diffPlanLines("# Plan\n\na\nb\n", "# Plan\n\na\n", markerTheme);
    assert.deepEqual(kinds(lines), ["context", "context", "context", "removed"]);
    const removed = lines[lines.length - 1];
    assert.equal(removed.text, "b");
    assert.ok(removed.styled.includes("toolDiffRemoved"), "removed line colored red");
    assert.ok(removed.styled.includes("~ST~"), "removed line struck through");
  });

  it("merges a single-line modification inline (red removed + green added)", () => {
    const lines = diffPlanLines("# Plan\n\na\n", "# Plan\n\nb\n", markerTheme);
    assert.deepEqual(kinds(lines), ["context", "context", "modified"]);
    const mod = lines[lines.length - 1];
    assert.equal(mod.text, "b");
    assert.ok(mod.styled.includes("toolDiffRemoved"), "modified shows removed tokens");
    assert.ok(mod.styled.includes("toolDiffAdded"), "modified shows added tokens");
  });

  it("renders a multi-line replacement as contiguous removed then added runs", () => {
    const lines = diffPlanLines("x\n1\n2\n", "x\na\n", markerTheme);
    assert.deepEqual(kinds(lines), ["context", "removed", "removed", "added"]);
    assert.equal(lines[1].text, "1");
    assert.equal(lines[2].text, "2");
    assert.equal(lines[3].text, "a");
  });

  it("leaves an unchanged plan all 'context' with no changes", () => {
    const content = "# Plan\n\n## Steps\n\n- [ ] Step 1\n";
    const lines = diffPlanLines(content, content, markerTheme);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => l.kind === "context"));
    assert.equal(hasChanges(lines), false);
  });

  it("preserves unchanged lines with plain text (no color)", () => {
    const lines = diffPlanLines("a\nb\n", "a\nb\n", markerTheme);
    for (const l of lines) assert.equal(l.styled, l.text, "context line unstyled");
  });
});

describe("countChanges / hasChanges", () => {
  it("counts added and removed lines", () => {
    const lines = diffPlanLines("a\n1\n2\n", "a\nb\n", markerTheme);
    assert.deepEqual(countChanges(lines), { additions: 1, removals: 2 });
    assert.equal(hasChanges(lines), true);
  });

  it("counts a modified line as one addition and one removal", () => {
    const lines = diffPlanLines("a\n", "b\n", markerTheme);
    assert.deepEqual(countChanges(lines), { additions: 1, removals: 1 });
  });

  it("reports no changes for identical content", () => {
    assert.equal(hasChanges(diffPlanLines("a\n", "a\n", markerTheme)), false);
    assert.deepEqual(countChanges(diffPlanLines("a\n", "a\n", markerTheme)), {
      additions: 0,
      removals: 0,
    });
  });
});
