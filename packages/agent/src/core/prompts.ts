export const toolResult = {
  /** Between the head and the tail of a clipped tool result, the number of characters left out (tool.ts clip). */
  clippedNote: (omitted: number) => `\n\n…（省略了 ${omitted} 个字符）…\n\n`,
};
