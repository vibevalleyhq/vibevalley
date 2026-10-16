/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-argument -- Untyped raw ACP child-process fixture using a captured native error. */
import { readFileSync } from "node:fs";

const { error: refusal } = JSON.parse(readFileSync(new URL("../replay/fixtures/opencode-acp-v2-refusal.json", import.meta.url), "utf8"));
/** Refusal orders around the original prompt's native answer. */
export default function refuseSteer({ text, pending, id, result, error }) {
  if (text !== "refused-steer" && text !== "refused-steer-after-end") {
    return false;
  }
  if (text === "refused-steer-after-end") {
    for (const promptId of pending.keys()) {
      result(promptId, { stopReason: "end_turn" });
    }
    pending.clear();
  }
  setTimeout(() => { error(id, refusal.code, refusal.message, refusal.data); }, 40);
  return true;
}
