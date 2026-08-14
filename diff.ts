/**
 * Last-round diff highlighting for the plan viewer.
 *
 * Pure, unit-testable diff logic: given the plan content *before* the last
 * agent round and the content *after* (current), produce a full-document
 * inline diff — every line of the plan, with additions highlighted green,
 * removals highlighted red (with an optional strikethrough as a
 * color-independent cue), and unchanged lines left unmarked. Single-line
 * modifications are merged inline (red removed + green added on one line)
 * instead of a separate removed/added pair, so the document stays compact
 * and readable.
 *
 * "Highlighted" here means a **background** highlight (red/green behind the
 * text), not a font/foreground recolor — the glyph color stays the normal
 * terminal color so the plan reads as plain text with marked-up lines.
 *
 * Deliberately no visible `+`/`-` gutter: the whole point of this view is to
 * keep the plan copy-paste clean (a leading marker would have to be trimmed
 * from every copied line). The highlight is emitted as ANSI SGR attributes
 * (background + optional strikethrough), which are not part of
 * terminal-selected text, so copy-paste yields the clean plan text.
 */

import { diffLines, diffWords } from "diff";

/** One rendered line of the diff view. */
export type DiffKind = "context" | "added" | "removed" | "modified";

export interface DiffLine {
  kind: DiffKind;
  /** Plain (unstyled) text — the actual plan line content. */
  text: string;
  /** Pre-styled (ANSI-highlighted) string for terminal rendering. */
  styled: string;
}

/** ANSI SGR sequences used for the highlight. */
export const ANSI_BG_RED = "\x1b[41m";
export const ANSI_BG_GREEN = "\x1b[42m";
export const ANSI_STRIKETHROUGH = "\x1b[9m";
export const ANSI_RESET = "\x1b[0m";

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

/** Highlight an added segment with a green background. */
function styleAdded(text: string): string {
  return ANSI_BG_GREEN + text + ANSI_RESET;
}

/** Highlight a removed segment with a red background (+ optional strikethrough). */
function styleRemoved(text: string): string {
  const mid = DIFF_STRIKETHROUGH_REMOVED ? ANSI_STRIKETHROUGH + text : text;
  return ANSI_BG_RED + mid + ANSI_RESET;
}

/**
 * Render a single-line modification (one removed line replaced by one added
 * line) as ONE line: unchanged words unmarked, removed words red-highlighted
 * (strikethrough), added words green-highlighted, inline. `diffWords` groups
 * whitespace with adjacent words so the highlighting stays readable.
 */
function styleModified(removedText: string, addedText: string): DiffLine {
  let styled = "";
  for (const part of diffWords(removedText, addedText)) {
    if (part.removed) {
      styled += styleRemoved(part.value);
    } else if (part.added) {
      styled += styleAdded(part.value);
    } else {
      styled += part.value;
    }
  }
  return { kind: "modified", text: addedText, styled };
}

/**
 * Compute a full-document inline diff between `before` and `after`.
 *
 * `before` is the plan content captured at the end of the previous agent round
 * (so a first round, with no prior baseline, yields no diff); `after` is the
 * current plan content. Every line of the document is emitted:
 * - unchanged → `context` (styled = plain text, unmarked)
 * - added     → `added`   (green background highlight)
 * - removed   → `removed` (red background highlight, optional strikethrough)
 * - a single removed+added pair → `modified` (inline red+green highlight)
 */
export function diffPlanLines(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  const parts = diffLines(before, after);
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      // Unchanged context block — unmarked.
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
      out.push(styleModified(removed[0], added[0]));
    } else {
      for (const r of removed) out.push({ kind: "removed", text: r, styled: styleRemoved(r) });
      for (const a of added) out.push({ kind: "added", text: a, styled: styleAdded(a) });
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
