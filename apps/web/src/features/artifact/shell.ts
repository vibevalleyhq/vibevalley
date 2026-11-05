import { Option, Schema } from "effect";

import { artifactPath, type HtmlAnchor } from "@vibevalley/protocol";
import { HtmlShellMessage } from "@vibevalley/protocol/schema";

export const shellPath = (id: string, version: number) => `${artifactPath(id, version)}?shell=1`;

const decode = Schema.decodeUnknownOption(HtmlShellMessage);
/** Longer than the shell sends: its context is 32 characters a side, and a page's words are far fewer than this. */
const wordsMax = 10_000;
const contextMax = 64;

/** The words the owner selected, as the message tells of them; undefined when it is no such message. */
export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const anchor = Option.getOrUndefined(decode(data))?.anchor;
  if (!anchor) return undefined;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}
