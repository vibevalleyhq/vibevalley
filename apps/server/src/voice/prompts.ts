const spoken = "口语，先说结论；不念代码、路径、命令和长列表。";

/** What a MOSS call's own model is told: how to open, and that farm work goes through the orchestrator. */
export function mossInstructions(greeting: string): string {
  const tail = "涉及农场现状、工单、帮工或派活时调用 ask_orchestrator。";
  return greeting ? `开场先简短问候：「${greeting}」。${tail}` : tail;
}

/** What the orchestrator is given to tell the user on the call: everything that waited, as one. */
/** A notice told on a call. */
export const noticeLine = (title: string, body: string) => (body ? title + "：" + body : title);

export function onCallLine(texts: readonly string[], ring?: string): string {
  const list = texts.map((t) => "- " + t).join("\n");
  if (ring)
    return (
      "用户接起了你打的电话。你打电话是为了这件事：" +
      ring +
      (list ? "\n这期间又有：\n" + list : "") +
      "\n先开口说这些：" +
      (texts.length > 0 ? "合成一段说，" : "一两句，") +
      spoken
    );
  return (
    "【要告诉用户】\n" +
    list +
    "\n\n用户正在和你通电话，你的回答会念给用户听：" +
    (texts.length > 1 ? `这 ${texts.length} 件合成一段说，一件一句，` : "一两句，") +
    spoken
  );
}
