import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { embedOf, linksIn, privateAddress, reachable, readEmbed } from "./embeds.ts";

const page = (html: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }, status = 200) =>
  new Response(html, { status, headers });

/** readEmbed on the farm's fetch client, with fetch itself the test's. */
const read = (link: string, get: typeof fetch, resolve: (host: string) => Promise<string[]>) =>
  Effect.runPromise(readEmbed(link, resolve).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, get)));

describe("a link's preview", () => {
  it("is read from the links in some words, three at most", () => {
    expect(linksIn("看 https://a.example/x，还有 (https://b.example/y). 和 https://a.example/x")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(linksIn("https://1.example https://2.example https://3.example https://4.example")).toHaveLength(3);
  });

  it("is never read from this computer, its network or its cloud", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.2", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
      expect(privateAddress(ip), ip).toBe(true);
    expect(privateAddress("93.184.216.34")).toBe(false);
    const at =
      (...ips: string[]) =>
      async () =>
        ips;
    expect(await reachable(new URL("https://example.com"), at("93.184.216.34"))).toBe(true);
    expect(await reachable(new URL("https://example.com"), at("93.184.216.34", "10.0.0.1"))).toBe(false);
    expect(await reachable(new URL("http://localhost:8787"), at("127.0.0.1"))).toBe(false);
    expect(await reachable(new URL("file:///etc/passwd"), at("93.184.216.34"))).toBe(false);
    expect(await reachable(new URL("https://user:pw@example.com"), at("93.184.216.34"))).toBe(false);
  });

  it("is what the page says of itself in its head", () => {
    const html = `<html><head><title>Plain</title><meta property="og:title" content="Rich &amp; full">
      <meta name="description" content="What it is"><meta property="og:site_name" content="Site"><meta property="og:image" content="/i.png"></head></html>`;
    expect(embedOf("https://example.com/a", html)).toEqual({
      url: "https://example.com/a",
      title: "Rich & full",
      description: "What it is",
      site: "Site",
      image: "https://example.com/i.png",
    });
    expect(embedOf("https://example.com", "<html><body>nothing</body></html>")).toBeUndefined();
  });

  it("follows a redirect only to a public address, and reads only a page", async () => {
    const resolve = async (host: string) => (host === "inside.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const asked: string[] = [];
    const get = (async (url: URL | string) => {
      const u = String(url);
      asked.push(u);
      if (u === "https://out.example/") return page("", { location: "https://inside.example/secret" }, 302);
      if (u === "https://pdf.example/") return page("%PDF", { "content-type": "application/pdf" });
      return page("<title>Fine</title>");
    }) as typeof fetch;
    expect(await read("https://out.example/", get, resolve)).toBeUndefined();
    expect(asked).toEqual(["https://out.example/"]);
    expect(await read("https://pdf.example/", get, resolve)).toBeUndefined();
    expect(await read("https://fine.example/", get, resolve)).toEqual({ url: "https://fine.example/", title: "Fine" });
  });
});
