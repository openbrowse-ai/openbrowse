import { describe, expect, it } from "vitest";
import { serializeParts, deserializePart } from "../useAgentChat";
import type {
  AgentUIMessage,
  CompletionCheckRejectionData,
  CompletionCheckRunningData,
} from "@/lib/types";

/**
 * Round-trip persistence contract for assistant message parts.
 *
 * `serializeParts` is a whitelist: only known part types survive the
 * trip to chat-db. New `AgentDataParts` variants must be added to BOTH
 * the serializer and the deserializer — these tests exist to catch
 * regressions where a UI part is rendered live but silently dropped
 * after a page reload.
 */

describe("serializeParts / deserializePart round-trip", () => {
  it("preserves data-completion-check-rejection across the round trip", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Two specific gaps.",
      concerns: [
        {
          dimension: "completeness",
          detail: "Asked for top 3 but listed 2.",
          userSummary: "Only 2 items listed but 3 were requested.",
          evidence: "draft mentions only 2 items",
        },
        {
          dimension: "planClosure",
          detail: "Two pending todos remain unclosed at completion.",
          userSummary: "Two items on your plan are still open.",
        },
      ],
      forceEmittedNext: false,
    };
    const live = [
      { type: "data-completion-check-rejection", data } as never,
    ] as AgentUIMessage["parts"];

    const serialized = serializeParts(live);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]).toEqual({
      type: "data-completion-check-rejection",
      data,
    });

    const rehydrated = serialized
      .map(deserializePart)
      .filter((p): p is NonNullable<typeof p> => p !== null);
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0]).toEqual({
      type: "data-completion-check-rejection",
      data,
    });
  });

  it("preserves data-completion-check-rejection with reason=evaluator-error", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Evaluator error: ...",
      concerns: [],
      forceEmittedNext: true,
      reason: "evaluator-error",
    };
    const live = [
      { type: "data-completion-check-rejection", data } as never,
    ] as AgentUIMessage["parts"];
    const round = serializeParts(live).map(deserializePart);
    expect(round[0]).toEqual({
      type: "data-completion-check-rejection",
      data,
    });
  });

  it("strips data-completion-check-running (done + approved) at serialize time", () => {
    // The running indicator is a live-stream concern only. Approve/
    // skip outcomes render nothing in the new minimal UX (no
    // "Verified" badge), and persisting them would be dead weight.
    // Verify the strip happens at serialize time so chatDb stays
    // clean.
    const data: CompletionCheckRunningData = {
      id: "run-1",
      phase: "done",
      outcome: "approved",
    };
    const live = [
      { type: "data-completion-check-running", data } as never,
    ] as AgentUIMessage["parts"];

    const serialized = serializeParts(live);
    expect(serialized).toHaveLength(0);
  });

  it("strips data-completion-check-running (done + rejected) at serialize time", () => {
    // Reject/force-emit running entries are also stripped — the
    // sibling rejection block carries the user-facing message; the
    // running entry has no remaining job after the stream closes.
    const data: CompletionCheckRunningData = {
      id: "run-1",
      phase: "done",
      outcome: "rejected",
    };
    const live = [
      { type: "data-completion-check-running", data } as never,
    ] as AgentUIMessage["parts"];
    expect(serializeParts(live)).toHaveLength(0);
  });

  it("strips data-completion-check-running (evaluating) at serialize time", () => {
    // An aborted stream may leave an "evaluating" entry in memory.
    // We don't persist those either — saved-means-stream-is-over;
    // a saved "evaluating" part would semantically lie. The
    // in-memory `isStreaming` guard handles the live abort case.
    const data: CompletionCheckRunningData = {
      id: "run-2",
      phase: "evaluating",
    };
    const live = [
      { type: "data-completion-check-running", data } as never,
    ] as AgentUIMessage["parts"];
    expect(serializeParts(live)).toHaveLength(0);
  });

  it("strips running entries from a mixed parts array, preserves order of survivors", () => {
    // Realistic case: text + running indicator interleaved. The
    // running indicator drops out; remaining parts keep their order.
    const live = [
      { type: "text", text: "I found three options." },
      {
        type: "data-completion-check-running",
        data: {
          id: "run-3",
          phase: "done",
          outcome: "approved",
        } as CompletionCheckRunningData,
      },
      { type: "text", text: "Final summary." },
    ] as never[] as AgentUIMessage["parts"];

    const serialized = serializeParts(live);
    expect(serialized).toHaveLength(2);
    expect(serialized[0]).toMatchObject({
      type: "text",
      text: "I found three options.",
    });
    expect(serialized[1]).toMatchObject({
      type: "text",
      text: "Final summary.",
    });
  });
});
