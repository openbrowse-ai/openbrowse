---
"openbrowse": patch
---

Tighten the completion check to focus on plan and task completion.

The "Refining answer" gate now judges only whether the executor actually finished the user's request and closed out its plan. The two dimensions that produced most of the false rejections — `evidenceGrounding` (claim-not-in-trace) and `surfaceAccuracy` (page-state-disagrees) — have been retired. Both relied on absence-of-evidence reasoning over heavily truncated tool-call traces; the executor often observed something on the live page that didn't survive the 800-character output truncation, and the evaluator would interpret that absence as fabrication and reject a correct answer.

The remaining concern dimensions are `completeness`, `planClosure`, and `noPrematureHandoff` — each judged against in-context material (the original request text, the todo list) rather than the trace's truncated tail. The evaluator's anti-hallucination guardrails are unchanged: it still defaults to skepticism, still won't reject on its own world knowledge, and still defers to what the executor saw.

The evaluator's optional with-tools / verification-call mode has been removed in the same pass — it existed primarily to ground the dimensions we're retiring, and the no-tools path was already production default.
