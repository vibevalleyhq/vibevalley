// Previews of the links said in the chat: the page's title, description, site and image, read by the server since a
// page cannot read another site. The server reaches only the public web: every address a name resolves to is checked
// before each request (and each redirect), so a link cannot make it read this computer, the LAN or a cloud's metadata.
// A name that resolves anew between that check and the request (DNS rebinding) is the gap left; nothing is sent with the
// request but the address, and only a page's head is read back.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Effect, Option, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import type { Embed } from "@vibevalley/protocol";
/** At most this many links of a message get a preview. */
export const embedMax = 3;
const timeoutMs = 3000;
const bodyMax = 512 * 1024;
const redirectsMax = 3;

/** A link is the characters a URL has: it ends where other words (a Chinese comma, a space) begin. */
const linkPattern = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+/gu;

/** The links in some words, once each, in order; a trailing stop or bracket is not part of one. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(linkPattern)) {
    const url = m[0].replace(/[.,;:!?\]]+$/u, "");
    if (!out.includes(url)) out.push(url);
  }
  return out.slice(0, embedMax);
}

/** An address only this computer, its network or its cloud reaches. */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb")
  );
}

/** The addresses a name has; none when it does not resolve. */
export type Resolve = (host: string) => Effect.Effect<readonly string[]>;
const resolveAll: Resolve = (host) =>
  isIP(host) !== 0
    ? Effect.succeed([host])
    : Effect.tryPromise(() => lookup(host, { all: true })).pipe(
        Effect.map((all) => all.map((a) => a.address)),
        Effect.orElseSucceed(() => []),
      );

/** May the server ask for this address: http(s), and every address its name has is on the public web. */
export const reachable = (url: URL, resolve: Resolve = resolveAll): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    const addresses = yield* resolve(host);
    return addresses.length > 0 && addresses.every((a) => !privateAddress(a));
  });

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gu, (_, e: string) => entities[e] ?? _).trim();
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What a page says of itself in its head: Open Graph first, then its title and description. */
export function embedOf(url: string, html: string): Embed | undefined {
  const head = html.slice(0, bodyMax);
  const meta = (key: string) => {
    for (const m of head.matchAll(/<meta\s+[^>]*>/giu)) {
      const tag = m[0];
      const name = /(?:property|name)\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]?.toLowerCase();
      const content = /content\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1];
      if (name === key && content) return decode(content);
    }
    return undefined;
  };
  const title = meta("og:title") ?? decode(/<title[^>]*>([^<]*)<\/title>/iu.exec(head)?.[1] ?? "");
  const description = meta("og:description") ?? meta("description");
  const site = meta("og:site_name");
  const image = meta("og:image");
  if (!title && !description) return undefined;
  let imageUrl: string | undefined;
  try {
    const u = image ? new URL(image, url) : undefined;
    if (u && (u.protocol === "https:" || u.protocol === "http:")) imageUrl = u.href;
  } catch {
    imageUrl = undefined;
  }
  return {
    url,
    title: cut(title, 200),
    description: cut(description ?? "", 300),
    site: cut(site ?? "", 80),
    image: imageUrl ?? "",
  };
}

/** A link's preview, or none when it cannot be read: not public, not a page, too slow, too big. Redirects are followed
 * here, not by the client, so each hop's address is checked before it is asked. */
export const readEmbed = Effect.fn("Embeds.read")(function* (link: string, resolve: Resolve = resolveAll) {
  const client = yield* HttpClient.HttpClient;
  if (!URL.canParse(link)) return undefined;
  let url = new URL(link);
  for (let hop = 0; hop <= redirectsMax; hop++) {
    const at = url;
    if (!(yield* reachable(at, resolve))) return undefined;
    const answered = yield* client.get(at, { headers: { accept: "text/html", "user-agent": "VibeValley link preview" } }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutOption(timeoutMs),
      Effect.catch(() => Effect.succeedNone),
    );
    if (Option.isNone(answered)) return undefined;
    const res = answered.value;
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers["location"];
      if (!next) return undefined;
      url = new URL(next, at);
      continue;
    }
    if (res.status < 200 || res.status >= 300 || !(res.headers["content-type"] ?? "").includes("text/html")) return undefined;
    // Only the head is wanted: reading stops at bodyMax, and the rest is never fetched.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const read = yield* res.stream.pipe(
      Stream.takeWhile(() => size < bodyMax),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
          size += chunk.length;
        }),
      ),
      Effect.timeoutOption(timeoutMs),
      Effect.result,
    );
    if (read._tag === "Failure" && chunks.length === 0) return undefined;
    return embedOf(link, new TextDecoder().decode(Buffer.concat(chunks).subarray(0, bodyMax)));
  }
  return undefined;
});
