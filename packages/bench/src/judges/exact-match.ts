/**
 * Judge for tasks where the agent's final answer must equal an expected
 * string. Whitespace is normalized (trim + collapse internal runs) so
 * trailing newlines or formatting differences don't fail an otherwise
 * correct answer. Comparison is case-sensitive — if you want
 * case-insensitive matching, lowercase both sides at task-definition time.
 */

import type { JudgeVerdict } from "./types";

export function exactMatch(
  agentAnswer: string,
  expected: string,
): JudgeVerdict {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
  const got = normalize(agentAnswer);
  const want = normalize(expected);
  return {
    passed: got === want,
    reasoning:
      got === want
        ? `exact-match: got "${got}"`
        : `exact-match: expected "${want}", got "${got}"`,
  };
}
