/**
 * Judge for navigation tasks where success is "the agent ended up on a URL
 * matching the expected pattern." Pattern is interpreted as a JS regex
 * (without leading/trailing slashes). Anchor it with ^ and $ if you want
 * exact matching.
 */

import type { JudgeVerdict } from "./types";

export function urlMatch(finalUrl: string, pattern: string): JudgeVerdict {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return {
      passed: false,
      reasoning: `url-match: invalid pattern "${pattern}" (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  const passed = re.test(finalUrl);
  return {
    passed,
    reasoning: passed
      ? `url-match: ${finalUrl} matches /${pattern}/`
      : `url-match: ${finalUrl} does not match /${pattern}/`,
  };
}
