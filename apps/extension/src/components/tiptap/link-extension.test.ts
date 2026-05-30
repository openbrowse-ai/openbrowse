// @vitest-environment happy-dom
import { Editor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { NoAutoLink } from "./link-extension";

/**
 * Reproduction for the copy/paste link-nesting bug.
 *
 * Pasting the markdown link `[news.google.com](http://news.google.com)`
 * into the chat input used to nest one extra layer per copy/paste cycle
 * because the stock Link extension's paste rule wrapped the URL
 * substrings inside the literal text. NoAutoLink disables that.
 */

const LINK = "[news.google.com](http://news.google.com)";

function makeEditor(useFix: boolean): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: useFix
      ? [StarterKit.configure({ link: false }), NoAutoLink, Markdown]
      : [StarterKit, Markdown],
  });
}

/** Simulate a real clipboard paste of plain text into the editor. */
function pasteText(editor: Editor, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  // ProseMirror listens on the editable DOM node.
  editor.view.dom.dispatchEvent(event);
}

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  document.body.innerHTML = "";
});

describe("link paste round-trip", () => {
  it("stock Link nests the markdown link on paste (reproduces the bug)", () => {
    const editor = makeEditor(false);
    editors.push(editor);
    editor.commands.setContent("");
    editor.commands.focus();
    pasteText(editor, LINK);
    // Stock behavior corrupts: the URL substrings get re-wrapped.
    expect(editor.getMarkdown()).not.toBe(LINK);
  });

  it("NoAutoLink preserves the markdown link verbatim on paste", () => {
    const editor = makeEditor(true);
    editors.push(editor);
    editor.commands.setContent("");
    editor.commands.focus();
    pasteText(editor, LINK);
    expect(editor.getMarkdown().trim()).toBe(LINK);
  });

  it("NoAutoLink is idempotent across repeated paste cycles", () => {
    const editor = makeEditor(true);
    editors.push(editor);
    let current = LINK;
    for (let i = 0; i < 4; i++) {
      editor.commands.setContent("");
      editor.commands.focus();
      pasteText(editor, current);
      current = editor.getMarkdown().trim();
      expect(current).toBe(LINK);
    }
  });
});
