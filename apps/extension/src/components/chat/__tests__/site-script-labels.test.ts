import { describe, expect, it } from "vitest";
import {
  deleteLabels,
  executeOnPageLabels,
  siteSkillLabels,
} from "../ToolCallBlock";

describe("deleteLabels", () => {
  const fallback = { pending: "Deleting...", done: "Deleted" };

  it("uses the basename of a path (without .js)", () => {
    expect(
      deleteLabels({ path: "/skills/linkedin.com/extract-comments.js" }, fallback),
    ).toEqual({
      pending: "Deleting `extract-comments`...",
      done: "Deleted `extract-comments`",
    });
  });

  it("uses the basename of a generic workspace path", () => {
    expect(deleteLabels({ path: "notes/todo.md" }, fallback)).toEqual({
      pending: "Deleting `todo.md`...",
      done: "Deleted `todo.md`",
    });
  });

  it("handles a trailing-slash directory path", () => {
    expect(deleteLabels({ path: "/skills/linkedin.com/" }, fallback)).toEqual({
      pending: "Deleting `linkedin.com`...",
      done: "Deleted `linkedin.com`",
    });
  });

  it("falls back when path is missing/blank", () => {
    expect(deleteLabels({}, fallback)).toBe(fallback);
    expect(deleteLabels({ path: "   " }, fallback)).toBe(fallback);
    expect(deleteLabels({ path: 42 }, fallback)).toBe(fallback);
  });
});

describe("executeOnPageLabels", () => {
  const fallback = { pending: "Running code...", done: "Ran code" };

  it("names a saved site-skill script (scriptRef) run", () => {
    expect(
      executeOnPageLabels(
        { scriptRef: { skill: "linkedin.com", script: "list-posts.js" } },
        fallback,
      ),
    ).toEqual({
      pending: "Running `list-posts.js`...",
      done: "Ran `list-posts.js`",
    });
  });

  it("falls back for inline code runs (no scriptRef)", () => {
    expect(executeOnPageLabels({ code: "return 1;" }, fallback)).toBe(fallback);
    expect(executeOnPageLabels({}, fallback)).toBe(fallback);
  });

  it("falls back when scriptRef has no usable script", () => {
    expect(executeOnPageLabels({ scriptRef: {} }, fallback)).toBe(fallback);
    expect(
      executeOnPageLabels({ scriptRef: { script: "  " } }, fallback),
    ).toBe(fallback);
  });
});

describe("siteSkillLabels", () => {
  it("splices the domain into the update label", () => {
    const fallback = { pending: "Updating site skill...", done: "Updated site skill" };
    expect(siteSkillLabels({ domain: "linkedin.com" }, fallback)).toEqual({
      pending: "Updating site skill `linkedin.com`...",
      done: "Updated site skill `linkedin.com`",
    });
  });

  it("splices the domain into the delete label", () => {
    const fallback = { pending: "Deleting site skill...", done: "Deleted site skill" };
    expect(siteSkillLabels({ domain: "github.com" }, fallback)).toEqual({
      pending: "Deleting site skill `github.com`...",
      done: "Deleted site skill `github.com`",
    });
  });

  it("falls back when domain is missing/blank", () => {
    const fallback = { pending: "Updating site skill...", done: "Updated site skill" };
    expect(siteSkillLabels({}, fallback)).toBe(fallback);
    expect(siteSkillLabels({ domain: "  " }, fallback)).toBe(fallback);
  });
});
