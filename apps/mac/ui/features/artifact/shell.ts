import type { HtmlAnchor, HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

export const shellMessageOf = (data: unknown): HtmlShellMessage | undefined => {
  const got = S.HtmlShellMessage.safeParse(data);
  return got.success ? got.data : undefined;
};

const wordsMax = 10_000;
const contextMax = 64;

export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const message = shellMessageOf(data);
  if (message?.vibevalley !== "selection") return undefined;
  const { anchor } = message;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}
