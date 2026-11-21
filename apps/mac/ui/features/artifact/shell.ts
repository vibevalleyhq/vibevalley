import type { HtmlAnchor, HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

export const themeVariables: Record<ShellTheme, string> = {
  light:
    "color-scheme:light;--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-faint:#716a64;--vv-line:#1c191714;--vv-accent:#4d7a2a;--vv-leaf:#74a046;--vv-wheat:#e5a93c;--vv-berry:#a83a2c;--vv-water:#2f6fa8;",
  dark: "color-scheme:dark;--vv-page:#151413;--vv-side:#1b1a18;--vv-ink:#ecebe8;--vv-muted:#a9a49e;--vv-faint:#8b867f;--vv-line:#ecebe81a;--vv-accent:#7fae4f;--vv-leaf:#8dbb5c;--vv-wheat:#e5a93c;--vv-berry:#e47d6d;--vv-water:#6aa6dc;",
};
export const typeVariables =
  '--vv-font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--vv-font-mono:Menlo,ui-monospace,monospace;--vv-radius:8px;';

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
