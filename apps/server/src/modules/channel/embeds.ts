import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import type { Embed } from "@vibevalley/protocol";
import { cut } from "@vibevalley/protocol/rules";
/** At most this many links of a message get a preview. */
const embedMax = 3;
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
export type Resolve = (host: string) => Promise<readonly string[]>;
const resolveAll: Resolve = async (host) => {
  if (isIP(host) !== 0) return [host];
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    // A name that does not resolve has no addresses: no preview is read, which is all it means here.
    return [];
  }
};

/** May the server ask for this address: http(s), and every address its name has is on the public web. */
export async function reachable(url: URL, resolve: Resolve = resolveAll): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const addresses = await resolve(host);
  return addresses.length > 0 && addresses.every((a) => !privateAddress(a));
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gu, (_, e: string) => entities[e] ?? _).trim();
/** At most n units, the ellipsis among them. */
const upTo = (s: string, n: number) => cut(s, n - 1);

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
    title: upTo(title, 200),
    description: upTo(description ?? "", 300),
    site: upTo(site ?? "", 80),
    image: imageUrl ?? "",
  };
}

/** A link's preview, or none when it cannot be read: not public, not a page, too slow, too big. */
export async function readEmbed(get: typeof fetch, link: string, resolve: Resolve = resolveAll): Promise<Embed | undefined> {
  if (!URL.canParse(link)) return undefined;
  let url = new URL(link);
  for (let hop = 0; hop <= redirectsMax; hop++) {
    const at = url;
    if (!(await reachable(at, resolve))) return undefined;
    let res: Response;
    try {
      // Real time: the deadline is on a request to the web, not on the farm's clock.
      res = await get(at, {
        headers: { accept: "text/html", "user-agent": "VibeValley link preview" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Not answered, or not in time: the link has no preview, which is what the caller is told.
      return undefined;
    }
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      const next = res.headers.get("location");
      if (!next) return undefined;
      url = new URL(next, at);
      continue;
    }
    if (res.status < 200 || res.status >= 300 || !(res.headers.get("content-type") ?? "").includes("text/html")) {
      await discard(res);
      return undefined;
    }
    // Only the head is wanted: reading stops at bodyMax (or after timeoutMs), and the rest is never fetched.
    const chunks: Uint8Array[] = [];
    let size = 0;
    let failed = false;
    // The body is bytes: what fetch gives is typed as any chunk.
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
    if (reader) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const late = new Promise<"late">((done) => deadline.addEventListener("abort", () => done("late"), { once: true }));
      try {
        while (size < bodyMax) {
          const r = await Promise.race([reader.read(), late]);
          if (r === "late" || r.done) break;
          chunks.push(r.value);
          size += r.value.length;
        }
      } catch {
        // A body cut off midway: what was read is still read for the head.
        failed = true;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    if (failed && chunks.length === 0) return undefined;
    return embedOf(link, new TextDecoder().decode(Buffer.concat(chunks).subarray(0, bodyMax)));
  }
  return undefined;
}

/** A body not read is let go of, so its connection is. */
const discard = (res: Response) => res.body?.cancel().catch(() => undefined);
