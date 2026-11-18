export interface MessageUse {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly prefix: boolean;
}

export function messageUses(file: string, text: string): MessageUse[] {
  const uses: MessageUse[] = [];
  const add = (pattern: RegExp, prefix: boolean) => {
    for (const m of text.matchAll(pattern)) uses.push({ file, line: text.slice(0, m.index).split("\n").length, key: m[1]!, prefix });
  };
  add(/\b(?:t|maybe)\(\s*"([a-z][\w.-]*\.[\w.$/-]+)"/gu, false);
  add(/\b(?:t|maybe)\(\s*`([a-z][\w.-]*\.[^`$]*)\$\{/gu, true);
  if (file.endsWith(".rs")) {
    add(/\bformat!\(\s*"([a-z][\w.-]*\.[\w.-]+)\{/gu, true);
    add(/\bt_in\(\s*[^,]+,\s*"([a-z][\w.-]*\.[\w.$/-]+)"/gu, false);
  }
  return uses;
}
