/**
 * Last-round diff highlighting for the plan viewer.
 *
 * Pure, unit-testable diff logic: given the plan content *before* the last
 * agent round and the content *after* (current), produce a full-document
 * inline diff — every line of the plan, with additions tinted green
 * (`toolDiffAdded`), removals tinted red (`toolDiffRemoved`, plus an optional
 * strikethrough as a color-independent cue), and unchanged lines left in the
 * normal text color. Single-line modifications are merged inline (red removed
 * tokens + green added tokens on one line) instead of a separate removed/added
 * pair, so the document stays compact and readable.
 *
 * Deliberately no visible `+`/`-` gutter: the whole point of this view is to
 * keep the plan copy-paste clean (a leading marker would have to be trimmed
 * from every copied line). Color/strikethrough are ANSI attributes only, which
 * are not part of terminal-selected text.
 *
 * The rendering here is bound to the `Theme` *instance* the extension is handed
 * (not pi's module-global theme), so runtime theme switches are respected —
 * consistent with `buildMarkdownTheme`/`buildEditorTheme` in utils.ts. It
 * reuses the same algorithm pi's own `renderDiff` uses (jsdiff `diffLines` +
 * `diffWords`), but colors with the instance theme and renders a full document
 * rather than a compact unified diff.
 */

import { diffLines, diffWords } from "diff";

/** One rendered line of the diff view. */
export type DiffKind = "context" | "added" | "removed" | "modified";

export interface DiffLine {
  kind: DiffKind;
  /** Plain (unstyled) text — the actual plan line content. */
  text: string;
  /** Pre-styled (ANSI-colored) string for terminal rendering. */
  styled: string;
}

/**
 * Minimal theme surface `diffPlanLines` needs from a pi `Theme`. Typed as a
 * narrow interface so the function is trivially unit-testable with a fake
 * theme (no real Theme required).
 */
export interface DiffTheme {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

/**
 * Single, easy-to-flip switch for the strikethrough on removed lines.
 * Flip to `false` in one place if cross-terminal testing shows strikethrough
 * renders poorly (see the AUDIT dependency note and the follow-up test).
 */
export const DIFF_STRIKETHROUGH_REMOVED = true;

/** Strip trailing newline noise from a diff block; returns individual lines. */
function splitLines(block: string): string[] {
  if (block.length === 0) return [];
  const parts = block.split("\n");
  // A block ending in "\n" yields a trailing "" that is just the terminator.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Color a removed line, optionally with strikethrough on top. */
function styleRemoved(text: string, theme: DiffTheme): string {
  if (DIFF_STRIKETHROUGH_REMOVED) {
    return theme.fg("toolDiffRemoved", theme.strikethrough(text));
  }
  return theme.fg("toolDiffRemoved", text);
}

function styleAdded(text: string, theme: DiffTheme): string {
  return theme.fg("toolDiffAdded", text);
}

/**
 * Render a single-line modification (one removed line replaced by one added
 * line) as ONE line: unchanged words in the normal color, removed words red
 * (strikethrough), added words green, inline. `diffWords` groups whitespace
 * with adjacent words so the highlighting stays readable.
 */
function styleModified(removedText: string, addedText: string, theme: DiffTheme): DiffLine {
  let styled = "";
  for (const part of diffWords(removedText, addedText)) {
    if (part.removed) {
      styled += DIFF_STRIKETHROUGH_REMOVED
        ? theme.fg("toolDiffRemoved", theme.strikethrough(part.value))
        : theme.fg("toolDiffRemoved", part.value);
    } else if (part.added) {
      styled += theme.fg("toolDiffAdded", part.value);
    } else {
      styled += part.value;
    }
  }
  return { kind: "modified", text: addedText, styled };
}

/**
 * Compute a full-document inline diff between `before` and `after`.
 *
 * `before` is the plan content captured at the start of the last agent round;
 * `after` is the current plan content. Every line of the document is emitted:
 * - unchanged → `context` (styled = plain text, normal color)
 * - added     → `added`   (green)
 * - removed   → `removed` (red, optional strikethrough)
 * - a single removed+added pair → `modified` (inline red+green word highlight)
 */
export function diffPlanLines(before: string, after: string, theme: DiffTheme): DiffLine[] {
  const out: DiffLine[] = [];
  const parts = diffLines(before, after);
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      // Unchanged context block — normal text color.
      for (const line of splitLines(part.value)) {
        out.push({ kind: "context", text: line, styled: line });
      }
      i++;
      continue;
    }
    // A change hunk: consume the consecutive removed lines, then the
    // consecutive added lines (the standard replaced-block shape).
    const removed: string[] = [];
    const added: string[] = [];
    while (i < parts.length && parts[i].removed) {
      removed.push(...splitLines(parts[i].value));
      i++;
    }
    while (i < parts.length && parts[i].added) {
      added.push(...splitLines(parts[i].value));
      i++;
    }
    if (removed.length === 1 && added.length === 1) {
      out.push(styleModified(removed[0], added[0], theme));
    } else {
      for (const r of removed) out.push({ kind: "removed", text: r, styled: styleRemoved(r, theme) });
      for (const a of added) out.push({ kind: "added", text: a, styled: styleAdded(a, theme) });
    }
  }
  return out;
}

export interface ChangeCounts {
  additions: number;
  removals: number;
}

/**
 * Count added/removed lines for the viewer's `+N −M` hint. A `modified` line
 * counts as both one addition and one removal (it replaced one line with
 * another).
 */
export function countChanges(lines: readonly DiffLine[]): ChangeCounts {
  let additions = 0;
  let removals = 0;
  for (const line of lines) {
    if (line.kind === "added") additions++;
    else if (line.kind === "removed") removals++;
    else if (line.kind === "modified") {
      additions++;
      removals++;
    }
  }
  return { additions, removals };
}

/** True when the diff shows any change (for deciding whether to highlight). */
export function hasChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.kind !== "context");
}
