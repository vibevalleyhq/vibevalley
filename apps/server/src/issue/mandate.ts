import type * as T from "@vibevalley/protocol";

const defaultBotReviewRounds = 3;
export const mandateNoteWordLimit = 30;
const words = new Intl.Segmenter("und", { granularity: "word" });

export function mandateNoteFits(text: string): boolean {
  let count = 0;
  for (const word of words.segment(text)) if (word.isWordLike === true && ++count > mandateNoteWordLimit) return false;
  return true;
}

const mandate = (strength: T.MandateStrength, originTriggerId: string, autoSubmitPr: boolean): T.IssueMandate => ({
  ...(originTriggerId === "" ? {} : { originTriggerId }),
  strength,
  maxBotReviewRounds: defaultBotReviewRounds,
  autoSubmitPr,
});

export const explicitMandate = (originTriggerId = "", autoSubmitPr = false): T.IssueMandate => mandate("explicit", originTriggerId, autoSubmitPr);
export const inferredMandate = (originTriggerId = ""): T.IssueMandate => mandate("inferred", originTriggerId, false);
