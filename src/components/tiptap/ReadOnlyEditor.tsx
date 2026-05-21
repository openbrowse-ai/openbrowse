import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SkillSlashReadonly } from "./skill-slash-extension";
import { TabMentionReadonly } from "./tab-mention-extension";

interface ReadOnlyEditorProps {
  content: string;
  className?: string;
}

export function ReadOnlyEditor({ content, className }: ReadOnlyEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    content,
    contentType: "markdown",
    extensions: [StarterKit, Markdown, TabMentionReadonly, SkillSlashReadonly],
    editorProps: {
      attributes: {
        class: className ?? "",
      },
    },
  });

  return <EditorContent editor={editor} />;
}
