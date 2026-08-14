/**
 * Full-screen plan viewer: rendered markdown (view mode) ⇄ full editor
 * (edit mode), toggled in place with `e`. Hosted via `ctx.ui.custom` as a
 * focused overlay; the component self-manages view-mode scrolling (the
 * overlay layout does not drive pi-tui ScrollViews).
 *
 * Key facts (verified in pi-tui source):
 * - Plain PageUp/PageDown/Home/End are consumed by the alt-screen viewport
 *   handler before any focused component (they scroll the conversation
 *   transcript), so view mode scrolls with the keys that do arrive:
 *   up/down arrows (line), ctrl+pageUp/ctrl+pageDown (page, matched via
 *   `tui.editor.pageUp/pageDown`), `g`/`G` (top/bottom). If a user remaps
 *   `tui.altScreen.pageUp` etc. in their keybindings config, plain PageUp
 *   then reaches the viewer too.
 * - The embedded pi-tui `Editor` sizes its window and page size from
 *   `tui.terminal.rows * 0.3` (minimum 5). We hand it a proxy tui whose
 *   `terminal.rows` is inflated so the editor's native window matches the
 *   overlay viewport — edit mode is full-screen with the editor's own
 *   cursor-following scroll and paging intact.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  EditorTheme,
  Focusable,
  KeybindingsManager,
  MarkdownTheme,
  TUI,
} from "@earendil-works/pi-tui";
import { Editor, Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  countChanges,
  diffPlanLines,
  hasChanges,
  type ChangeCounts,
  type DiffLine,
} from "./diff.ts";
import { buildEditorTheme, buildMarkdownTheme, isSymlink, PLAN_TEMPLATE } from "./utils.ts";

/** Rows reserved for the chrome (title + hint lines) in view mode. */
const CHROME_LINES = 2;

/** Chrome rows around the editor in edit mode: our title + its two borders. */
const EDIT_CHROME = 3;

/**
 * The pi-tui `Editor` derives its window size from `tui.terminal.rows`
 * (`max(5, floor(rows * 0.3))`) in both `render()` and `pageScroll()`. This
 * proxy delegates everything to the real tui but presents a `terminal`
 * whose `rows` is inflated by the inverse factor, so the editor's window
 * and page size equal `getRows()` (the overlay viewport).
 */
function buildViewportTui(tui: TUI, getRows: () => number): TUI {
  const terminal = {
    get rows() {
      return getRows();
    },
  };
  return new Proxy(tui, {
    get(target, prop, receiver) {
      if (prop === "terminal") return terminal;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface PlanViewerCallbacks {
  /** Persist edited text and refresh surrounding state (widget, notify). */
  onSave(text: string): void;
  /** Close the viewer without saving. */
  onClose(): void;
}

export class PlanViewer implements Component, Focusable {
  private readonly tui: TUI;
  private readonly keybindings: KeybindingsManager;
  private readonly theme: Theme;
  private readonly mdTheme: MarkdownTheme;
  private readonly editorTheme: EditorTheme;
  private readonly planFile: string;
  private readonly callbacks: PlanViewerCallbacks;
  private readonly markdown: Markdown;
  private readonly editor: Editor;
  /** Perceived terminal height for the editor's window math (see setViewport). */
  private readonly editorRows = { value: 40 };
  private mode: "view" | "edit" | "diff" = "view";
  private scrollOffset = 0;
  /** Lines of the last view/diff-mode render at the current width. */
  private lines: string[] = [];
  /** Full-document inline diff of the last round (empty when none). */
  private readonly diffLines: DiffLine[] = [];
  /** Added/removed counts for the `+N −M` title hint. */
  private readonly diffCounts: ChangeCounts = { additions: 0, removals: 0 };
  /** Overlay viewport in rows; updated per render cycle via `setViewport`. */
  private viewport = 40;
  private focusedInternal = false;

  constructor(
    tui: TUI,
    keybindings: KeybindingsManager,
    theme: Theme,
    mdTheme: MarkdownTheme,
    editorTheme: EditorTheme,
    planFile: string,
    content: string,
    diffBefore: string | undefined,
    callbacks: PlanViewerCallbacks,
  ) {
    this.tui = tui;
    this.keybindings = keybindings;
    this.theme = theme;
    this.mdTheme = mdTheme;
    this.editorTheme = editorTheme;
    this.planFile = planFile;
    this.callbacks = callbacks;
    this.markdown = new Markdown(content, 0, 0, mdTheme);
    // The last-round diff is the default view when one exists; otherwise the
    // rendered plan. diffBefore is undefined (no prior round) or equals content
    // (no change) → plain rendered view.
    this.diffLines = diffBefore !== undefined ? diffPlanLines(diffBefore, content, theme) : [];
    this.diffCounts = countChanges(this.diffLines);
    this.mode = hasChanges(this.diffLines) ? "diff" : "view";
    this.editor = new Editor(buildViewportTui(tui, () => this.editorRows.value), editorTheme);
    this.editor.setText(content);
    // pi-tui's setText places the cursor at the END of the document, so the
    // editor's window would open at the bottom of the plan — start at the top.
    this.resetEditorToTop(content);
    // Enter submits (saves + returns to the rendered view); Shift+Enter inserts a newline.
    this.editor.onSubmit = (text) => this.commit(text);
  }

  /**
   * Move the editor cursor/window to the top of the plan. pi-tui's public
   * `setText()` always places the cursor at the end of the document
   * (`setTextInternal` defaults to `cursorPlacement: "end"`), and the
   * editor's render window follows the cursor — so without this the editor
   * opens at the bottom of the plan. `setTextInternal(text, "start")` puts
   * the cursor at (0,0) and resets the scroll offset. It is declared
   * private but pinned by pi-tui's `editor.d.ts`, hence the typed escape
   * hatch; it does not touch the buffer or the undo stack.
   */
  private resetEditorToTop(text?: string): void {
    const internal = this.editor as unknown as {
      setTextInternal(text: string, placement: "start" | "end"): void;
    };
    internal.setTextInternal(text ?? this.editor.getText(), "start");
  }

  get focused(): boolean {
    return this.focusedInternal;
  }

  set focused(value: boolean) {
    this.focusedInternal = value;
    this.editor.focused = value;
  }

  /** Called by the overlay `visible()` callback with the terminal height. */
  setViewport(height: number): void {
    this.viewport = Math.max(CHROME_LINES + 3, height);
    // Editor window = viewport − (title + top/bottom borders); inflate its
    // perceived terminal so `max(5, floor(rows * 0.3))` equals that window.
    const window = Math.max(5, this.viewport - EDIT_CHROME);
    this.editorRows.value = Math.ceil(window / 0.3);
  }

  invalidate(): void {
    this.markdown.invalidate();
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (this.mode === "edit") {
      // Escape / Ctrl+C cancels (same as the previous plan editor); Enter submits via onSubmit.
      if (kb.matches(data, "tui.select.cancel")) {
        this.callbacks.onClose();
        return;
      }
      this.editor.handleInput(data);
      return;
    }
    // ---- view mode ----
    if (kb.matches(data, "tui.select.cancel")) {
      this.callbacks.onClose();
      return;
    }
    if (kb.matches(data, "tui.editor.pageUp")) {
      this.scrollBy(-this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.editor.pageDown")) {
      this.scrollBy(this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.scrollBy(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.scrollBy(1);
      return;
    }
    if (data === "g") {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = this.maxScroll();
      this.tui.requestRender();
      return;
    }
    if (data === "e") {
      // Every entry into edit mode starts at the top of the plan.
      this.resetEditorToTop();
      this.mode = "edit";
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    if (this.mode === "edit") return this.renderEditMode(width);
    return this.mode === "diff" ? this.renderDiffMode(width) : this.renderViewMode(width);
  }

  private commit(text: string): void {
    this.callbacks.onSave(text);
    this.refreshContent(text);
  }

  /**
   * Re-sync both modes after a save (view shows what was saved, editor
   * keeps the buffer). pi-tui's `submitValue()` wipes the editor buffer on
   * submit, so it must be refilled — parked at the top for the next edit
   * session.
   */
  private refreshContent(text: string): void {
    this.markdown.setText(text);
    this.resetEditorToTop(text);
    this.scrollOffset = 0;
    this.mode = "view";
    this.tui.requestRender();
  }

  private renderViewMode(width: number): string[] {
    this.lines = this.markdown.render(width);
    return this.renderScrollable("view", this.lines, this.contentViewport());
  }

  private renderDiffMode(width: number): string[] {
    this.lines = this.renderDiffLines(width);
    return this.renderScrollable("diff", this.lines, this.contentViewport());
  }

  /** Shared viewport clipping + chrome for the two scrollable modes. */
  private renderScrollable(
    mode: "view" | "diff",
    lines: string[],
    viewport: number,
  ): string[] {
    const max = Math.max(0, lines.length - viewport);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, max));
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + viewport);
    return [this.titleLine(mode), ...visible, this.hintLine(viewport)];
  }

  /** Wrap each colored diff line to the content width and pad to full width. */
  private renderDiffLines(width: number): string[] {
    const out: string[] = [];
    for (const line of this.diffLines) {
      for (const wrapped of wrapTextWithAnsi(line.styled, width)) {
        out.push(wrapped + " ".repeat(Math.max(0, width - visibleWidth(wrapped))));
      }
    }
    return out.length > 0 ? out : [""];
  }

  private renderEditMode(width: number): string[] {
    const editorLines = this.editor.render(width);
    // The editor renders its window (content + two borders); slice defensively
    // so the total never exceeds the overlay viewport.
    return [this.titleLine("edit"), ...editorLines.slice(0, Math.max(1, this.viewport - 1))];
  }

  private titleLine(mode: "view" | "edit" | "diff"): string {
    const label = mode === "edit" ? "✏️ Edit" : "📋 Plan";
    const hints =
      mode === "edit"
        ? " · ctrl+pgup/pgdn page · enter save · shift+enter newline · esc close"
        : mode === "diff"
          ? ` · last round +${this.diffCounts.additions} −${this.diffCounts.removals} · e edit · esc close`
          : " · e edit · esc close";
    return (
      this.theme.fg("accent", label) +
      " " +
      this.theme.fg("muted", this.planFile) +
      this.theme.fg("dim", hints)
    );
  }

  private hintLine(contentViewport: number): string {
    const total = this.lines.length;
    let position = "";
    if (total > 0) {
      position =
        total > contentViewport
          ? ` · ${Math.min(this.scrollOffset + 1, total)}–${Math.min(
              this.scrollOffset + contentViewport,
              total,
            )}/${total}`
          : " · all";
    }
    return this.theme.fg("dim", `  ↑↓ scroll · ctrl+pgup/pgdn page · g/G top/bottom${position}`);
  }

  private contentViewport(): number {
    return Math.max(1, this.viewport - CHROME_LINES);
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.contentViewport());
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll(), this.scrollOffset + delta));
    this.tui.requestRender();
  }

  private pageSize(): number {
    // 2-line overlap between pages, mirroring pi's alt-screen page math.
    return Math.max(1, this.contentViewport() - 2);
  }
}

/**
 * Open the full-screen plan viewer. Resolves when the user closes it.
 * `onSaved` is invoked after a successful save (the file write happens here).
 * Without a UI, notifies with the plan file path instead.
 */
export async function openPlanViewer(
  ctx: ExtensionContext,
  planFile: string,
  diffBefore: string | undefined,
  onSaved: (text: string) => void,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`Plan file: ${planFile}`, "info");
    return;
  }
  let content: string;
  try {
    content = readFileSync(planFile, "utf8");
  } catch {
    content = PLAN_TEMPLATE;
  }
  const mdTheme = buildMarkdownTheme(ctx.ui.theme);
  const editorTheme = buildEditorTheme(ctx.ui.theme);

  let viewer: PlanViewer | undefined;
  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => {
      viewer = new PlanViewer(tui, keybindings, theme, mdTheme, editorTheme, planFile, content, diffBefore, {
        onSave: (text) => {
          // Refuse to save through a symlinked plan file: writeFileSync would
          // follow it and clobber its target (AUDIT R6).
          if (isSymlink(planFile)) {
            ctx.ui.notify(`Refusing to save: ${planFile} is a symlink.`, "error");
            return;
          }
          writeFileSync(planFile, text, "utf8");
          onSaved(text);
        },
        onClose: () => done(undefined),
      });
      return viewer;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        // Called each render cycle with the current terminal dimensions.
        visible: (_w, height) => {
          viewer?.setViewport(height);
          return true;
        },
      },
    },
  );
}
