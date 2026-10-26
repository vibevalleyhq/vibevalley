// What the orchestrator is told when the owner is on the phone: said to the model, in Chinese whatever the owner's
// locale (it answers in the owner's).

const spoken = "口语，先说结论；不念代码、路径、命令和长列表。";

/** What the orchestrator is given to tell the owner on the call: everything that waited, as one; ring is what rang, when the
 * owner just picked the call up for it. What it answers is read out. */
export function onCallLine(texts: readonly string[], ring?: string): string {
  const list = texts.map((t) => "- " + t).join("\n");
  if (ring)
    return (
      "主人接起了你打的电话。你打电话是为了这件事：" +
      ring +
      (list ? "\n这期间又有：\n" + list : "") +
      "\n先开口说这些：" +
      (texts.length > 0 ? "合成一段说，" : "一两句，") +
      spoken
    );
  return (
    "【要告诉主人】\n" +
    list +
    "\n\n主人正在和你通电话，你的回答会念给主人听：" +
    (texts.length > 1 ? `这 ${texts.length} 件合成一段说，一件一句，` : "一两句，") +
    spoken
  );
}
