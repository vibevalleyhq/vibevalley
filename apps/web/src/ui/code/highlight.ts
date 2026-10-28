// Code coloured off the page's thread (highlight.worker.ts): one worker for the page, started the first time code is
// shown; the newest results are kept, so a panel opened again is coloured at once.

import type { ColourRequest, Coloured } from "./highlight.worker";
import { languageOf } from "./languages";

export type Tokens = NonNullable<Coloured["lines"]>;

/** Past this many lines a block stays plain: colouring it would take longer than reading it. */
const maxLines = 3000;
const keep = 64;

let worker: Worker | undefined;
let next = 0;
const waiting = new Map<number, (lines: Tokens | undefined) => void>();
const done = new Map<string, Tokens>();

function request(code: string, lang: string): Promise<Tokens | undefined> {
  worker ??= (() => {
    const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Coloured>) => {
      waiting.get(e.data.id)?.(e.data.lines);
      waiting.delete(e.data.id);
    };
    return w;
  })();
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, code, lang } satisfies ColourRequest);
  });
}

/** The lines' tokens in the language of the file or fence named, or none: a language not coloured, too long a block,
 * or a colouring that failed (the plain lines stay). */
export async function highlight(lines: readonly string[], nameOrTag: string): Promise<Tokens | undefined> {
  const lang = languageOf(nameOrTag);
  if (!lang || lines.length === 0 || lines.length > maxLines) return undefined;
  const code = lines.join("\n");
  const key = `${lang}\n${code}`;
  const kept = done.get(key);
  if (kept) return kept;
  const got = await request(code, lang);
  if (got) {
    done.set(key, got);
    if (done.size > keep) done.delete(done.keys().next().value!);
  }
  return got;
}
