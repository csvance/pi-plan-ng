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
 * - The embedded pi-tui `Editor` self-manages its window (borders, internal
 *   scroll), so edit mode needs no viewport math.
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
import { Editor, Markdown } from "@earendil-works/pi-tui";
import { buildEditorTheme, buildMarkdownTheme, PLAN_TEMPLATE } from "./utils.ts";

/** Rows reserved for the chrome (title + hint lines) in view mode. */
const CHROME_LINES = 2;

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
  private mode: "view" | "edit" = "view";
  private scrollOffset = 0;
  /** Lines of the last view-mode render at the current width. */
  private lines: string[] = [];
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
    this.editor = new Editor(tui, editorTheme);
    this.editor.setText(content);
    // Enter submits (saves + returns to the rendered view); Shift+Enter inserts a newline.
    this.editor.onSubmit = (text) => this.commit(text);
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
      this.mode = "edit";
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    return this.mode === "edit" ? this.renderEditMode(width) : this.renderViewMode(width);
  }

  private commit(text: string): void {
    this.callbacks.onSave(text);
    this.refreshContent(text);
  }

  /** Re-sync both modes after a save (view shows what was saved, editor keeps the buffer). */
  private refreshContent(text: string): void {
    this.markdown.setText(text);
    this.scrollOffset = 0;
    this.mode = "view";
    this.tui.requestRender();
  }

  private renderViewMode(width: number): string[] {
    this.lines = this.markdown.render(width);
    const viewport = this.contentViewport();
    const max = Math.max(0, this.lines.length - viewport);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, max));
    const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + viewport);
    return [this.titleLine("view"), ...visible, this.hintLine(viewport)];
  }

  private renderEditMode(width: number): string[] {
    const editorLines = this.editor.render(width);
    return [this.titleLine("edit"), ...editorLines.slice(0, this.contentViewport())];
  }

  private titleLine(mode: "view" | "edit"): string {
    const label = mode === "view" ? "📋 Plan" : "✏️ Edit";
    const hints =
      mode === "view"
        ? " · e edit · esc close"
        : " · enter save · shift+enter newline · esc close";
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
      viewer = new PlanViewer(tui, keybindings, theme, mdTheme, editorTheme, planFile, content, {
        onSave: (text) => {
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
