import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { loadEnv } from "./src/env.ts";

loadEnv();

async function main() {
  try {
    const res = await generateText({
      model: google("gemini-3.5-flash"),
      prompt: "Say 'hello'."
    });
    console.log("Success:", res.text);
  } catch (err) {
    console.error("Error:", err);
  }
}
main();
