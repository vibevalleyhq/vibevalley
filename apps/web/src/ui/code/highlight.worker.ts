// Off the page's thread: Shiki colours code into tokens whose colours are the palette's CSS variables (style.css,
// --shiki-*), so they follow the theme without colouring twice. The JavaScript regex engine: no wasm to fetch.

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { loadLanguage } from "./languages";

export interface ColourRequest {
  readonly id: number;
  readonly code: string;
  readonly lang: string;
}

/** Each line's tokens: its text and the CSS colour it is drawn in. */
export interface Coloured {
  readonly id: number;
  readonly lines?: readonly (readonly { readonly text: string; readonly color?: string }[])[];
}

const theme = createCssVariablesTheme({ name: "palette", variablePrefix: "--shiki-" });
let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

async function colour(asked: ColourRequest): Promise<Coloured> {
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
  const h = await highlighter;
  if (!loaded.has(asked.lang)) {
    await h.loadLanguage(await loadLanguage(asked.lang));
    loaded.add(asked.lang);
  }
  const { tokens } = h.codeToTokens(asked.code, { lang: asked.lang, theme: "palette" });
  return { id: asked.id, lines: tokens.map((line) => line.map((tok) => ({ text: tok.content, ...(tok.color ? { color: tok.color } : {}) }))) };
}

self.onmessage = (e: MessageEvent<ColourRequest>) => {
  colour(e.data).then(
    (told) => self.postMessage(told),
    () => self.postMessage({ id: e.data.id } satisfies Coloured),
  );
};
