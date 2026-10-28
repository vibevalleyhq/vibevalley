// What the loop's tools say to the model, in Chinese whatever the owner's locale.

export const toolResult = {
  /** A tool result when the run was stopped while it worked, and the end of a tool the stop cut off (tool.ts). */
  stopped: "已停下",
  /** Between the head and the tail of a clipped tool result, the number of characters left out (tool.ts clip). */
  clippedNote: (omitted: number) => `\n\n…（省略了 ${omitted} 个字符）…\n\n`,
};
