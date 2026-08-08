import { describe, expect, it } from "vitest";
import {
  COHERENCE_CANARY_PROMPT,
  evaluateCanaryReply,
  scoreCoherence,
} from "../coherence";

/**
 * Real captured output from Hermes-3-Llama-3.1-8B (q4f16) on an Apple Metal
 * GPU, replying to the prompt "hello world". The model loaded and reported
 * success. This is the exact class of failure the detector exists to catch.
 */
const REAL_GARBLED_REPLY =
  "Coltsresetellaovsky fav-describedby-whá958puaugeihan:// (_REFiggerslinger " +
  "Lux-Lervalbert protontook Bern Angeles activityEQUALóvleftright básदर AD " +
  "Cochphpadinndaieżоменħ Creativeалеabwe-May326ывiboldvrieriggers Dhabi " +
  "介.scalablytyped,abethzioola680_PS Funnyxdfulkanessonkla.xmlbeansornadoldatavisorhap " +
  "gre nackte unreal387 RuntimeObject,ursettydam,घIBUT Fam-logo amon " +
  "Cunningham460&actionignon LENabbo counterimitsurespremium580овер449trysviders " +
  "Ünacci|string://Question Lamar many McCarthyचsitherurs\uFFFDaste Prompt " +
  "Prototypegnore ifad\uFFFD\uFFFD vinc114[баханистIDD\uFFFD Weissayarunders Wahl " +
  "Cocktailτιαëmëmphp FoleybertafiladayVERN addCriterion andagleicky\uFFFDalatplerylon " +
  "gmailPREC_HI __.swingikink-familyckerkart accordinglyerrick-tíوWalalletusalxDB " +
  "jadxMocksither erkenERGYavraspod Roose htonlamp bid\uFFFDDNvisor\uFFFDbes\uFFFD " +
  "ficuratxdf wo://_REFشمالىCU actorampp certif-fشمالى Pazد\uFFFD cancgencysink " +
  "gameTimeophelu Linkedj Purpleiten completelygetC slam/umdisman 438شهرى " +
  "fumann.lyotenttrysaget kommentltkér\uFFFD_Abstractンピ";

/** The AI-generated chat title from the same broken model. */
const REAL_GARBLED_TITLE =
  "Hello473ceae,...abeth favourleston सलua hab://<decltype 사 emp";

describe("scoreCoherence — detects real corruption", () => {
  it("flags the captured Hermes-3 q4f16 salad as garbled", () => {
    const r = scoreCoherence(REAL_GARBLED_REPLY);
    expect(r.verdict).toBe("garbled");
    expect(r.reasons.length).toBeGreaterThan(0);
    // Should trip several independent signals, not squeak by on one.
    expect(r.signals.replacementChars).toBeGreaterThanOrEqual(2);
    expect(r.signals.scriptGroups.length).toBeGreaterThanOrEqual(3);
  });

  it("flags the short garbled chat title too", () => {
    // Only ~9 words, so this proves detection doesn't depend on long samples.
    expect(scoreCoherence(REAL_GARBLED_TITLE).verdict).toBe("garbled");
  });

  it("flags degenerate token-loop output", () => {
    // mlc-llm #2982: a broken quantization emitting one special token forever.
    const looped = "<|reserved_special_token_247|>".repeat(64);
    const r = scoreCoherence(looped);
    expect(r.verdict).toBe("garbled");
    expect(r.signals.maxImmediateRepeat).toBeGreaterThanOrEqual(6);
  });

  it("flags a repeated-word loop (whitespace-separated degeneration)", () => {
    const r = scoreCoherence("the the the the the the the the the the");
    expect(r.verdict).toBe("garbled");
  });
});

describe("scoreCoherence — does not flag healthy output", () => {
  it("accepts an ordinary English reply", () => {
    const r = scoreCoherence(
      "Hello! It's nice to meet you. How can I help you today?",
    );
    expect(r.verdict).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("accepts technical prose containing quantization ids", () => {
    // Guards the letter+digit fusion rule: "q4f16" is legitimate and short.
    const r = scoreCoherence(
      "The q4f16 build uses 4-bit weights, while q4f32 keeps fp32 accumulators.",
    );
    expect(r.verdict).toBe("ok");
  });

  it("accepts a Japanese reply (Han + Kana + Latin is normal there)", () => {
    // Regression guard for naive script counting: Japanese legitimately mixes
    // kanji, hiragana and katakana, plus Latin — that must not read as salad.
    const r = scoreCoherence("こんにちは！私はAIアシスタントです。何かお手伝いできますか？");
    expect(r.signals.scriptGroups).toContain("CJK");
    expect(r.verdict).toBe("ok");
  });

  it("accepts a Russian reply", () => {
    const r = scoreCoherence("Привет! Я могу помочь вам с вашими вопросами.");
    expect(r.verdict).toBe("ok");
  });

  it("accepts a Hindi reply", () => {
    const r = scoreCoherence("नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?");
    expect(r.verdict).toBe("ok");
  });

  it("accepts a reply containing a code snippet", () => {
    const r = scoreCoherence(
      "Sure — use `arr.map((x) => x * 2)` to double each element of the array.",
    );
    expect(r.verdict).toBe("ok");
  });
});

describe("scoreCoherence — tolerates legitimate technical output", () => {
  // Agent replies routinely contain URLs, code and hashes. Those trip the
  // word-level signals (letter/digit fusions, overlong words) even though the
  // model is perfectly healthy, so they must be excluded before scoring.
  it("accepts a reply that is mostly long URLs", () => {
    const r = scoreCoherence(
      "I opened these pages: https://example.com/a/b?token=aX92kdl2mZq10ppQ and " +
        "https://docs.example.org/guide/v2/getting-started?ref=abc123def456ghi789 " +
        "and summarised both for you.",
    );
    expect(r.verdict).toBe("ok");
  });

  it("accepts a reply containing a fenced code block", () => {
    const r = scoreCoherence(
      "Here is the script I ran to collect the rows:\n\n" +
        "```js\nconst rows = [...document.querySelectorAll('tr')].map((r) => r.innerText);\n" +
        "const b64 = btoa(JSON.stringify(rows));\n```\n\nIt returned twelve rows.",
    );
    expect(r.verdict).toBe("ok");
  });

  it("accepts a reply quoting hashes and base64", () => {
    const r = scoreCoherence(
      "The file digest is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 " +
        "and the encoded payload begins iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ. " +
        "Both match what you sent earlier, so nothing changed.",
    );
    expect(r.verdict).toBe("ok");
  });

  it("still catches corruption that appears alongside code", () => {
    // Stripping must not become a loophole: whole-sample signals (replacement
    // chars, script mixing) are still read from the raw text.
    const r = scoreCoherence(
      "```js\nconst x = 1;\n```\n" + REAL_GARBLED_REPLY,
    );
    expect(r.verdict).toBe("garbled");
  });
});

describe("scoreCoherence — inconclusive cases", () => {
  it("reports empty output as inconclusive, not garbled", () => {
    expect(scoreCoherence("").verdict).toBe("inconclusive");
    expect(scoreCoherence("   \n ").verdict).toBe("inconclusive");
  });

  it("reports a terse reply as inconclusive rather than guessing", () => {
    const r = scoreCoherence("OK");
    expect(r.verdict).toBe("inconclusive");
    expect(r.reasons).toEqual(["too short to assess"]);
  });
});

describe("evaluateCanaryReply", () => {
  it("has a canary prompt with one unambiguous answer", () => {
    expect(COHERENCE_CANARY_PROMPT).toMatch(/OK/);
  });

  it("passes a compliant terse reply that scoreCoherence alone can't judge", () => {
    expect(scoreCoherence("OK").verdict).toBe("inconclusive");
    expect(evaluateCanaryReply("OK").verdict).toBe("ok");
    expect(evaluateCanaryReply("  ok.  ").verdict).toBe("ok");
  });

  it("passes a coherent but non-compliant reply", () => {
    // A small model ignoring the instruction is not a broken model.
    const r = evaluateCanaryReply(
      "Sure, I can do that. The word you asked for is OK.",
    );
    expect(r.verdict).toBe("ok");
  });

  it("still fails a reply that starts with OK then degenerates", () => {
    // Compliance must never override structural corruption.
    const r = evaluateCanaryReply(`OK ${REAL_GARBLED_REPLY}`);
    expect(r.verdict).toBe("garbled");
  });

  it("fails the real garbled reply", () => {
    expect(evaluateCanaryReply(REAL_GARBLED_REPLY).verdict).toBe("garbled");
  });
});
