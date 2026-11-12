import { describe, expect, test } from "vite-plus/test";

import { artifactPath, userId } from "@vibevalley/protocol";

import { remoteMay } from "#/gateway/lan/lan.ts";
import { htmlPolicy } from "#/modules/artifact/policy.ts";
import { app } from "#/testing/http.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

describe("an artifact's content", () => {
  test("is read back by GET at an html version's path, sandboxed, and nothing else is: a blocks one is not a file", async () => {
    await using served = await app(testConfig(), 0, undefined, quietApp);
    const { address } = served;
    const artifacts = served.farm.artifact;
    const user = { from: userId, by: userId };
    // The test reads the server as a browser does, through the platform's own fetch.
    const get = (path: string) => fetch(`http://${address}${path}`);
    const html = await artifacts.create(user, { title: "页", kind: "html", content: "<p>第一版</p>" });
    await artifacts.version(user, { id: html.id, content: "<p>第二版</p>" });
    const first = await get(artifactPath(html.id, 1));
    expect([first.status, first.headers.get("content-type"), first.headers.get("content-security-policy")]).toEqual([
      200,
      "text/html; charset=utf-8",
      htmlPolicy,
    ]);
    expect([first.headers.get("x-content-type-options"), first.headers.get("cache-control")]).toEqual(["nosniff", "private, max-age=31536000, immutable"]);
    const text2 = await first.text();
    expect(text2).toBe("<p>第一版</p>");
    // The test reads the server as a browser does, through the platform's own fetch.
    const text3 = await (await fetch(`http://${address}${artifactPath(html.id, 2)}`)).text();
    expect(text3).toBe("<p>第二版</p>");
    const shown = await get(`${artifactPath(html.id, 1)}?shell=1`);
    expect(shown.headers.get("content-security-policy")).toBe(htmlPolicy);
    // Only the page opened on its own to be printed may open the print dialog.
    const printed = await get(`${artifactPath(html.id, 1)}?shell=1&print=1`);
    expect(printed.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; /u,
    );
    expect(htmlPolicy).not.toMatch(/allow-modals/u);
    const shownText = await shown.text();
    expect(shownText).toMatch(/^<p>第一版<\/p>\n<style>[^]*vibevalley: "selection"[^]*\(\{ display: "page" \}\)/u);
    expect((await artifacts.content(html.id, 1)).content).toBe("<p>第一版</p>");
    const md = await artifacts.create(user, { title: "说明", kind: "markdown", content: "# 题\n\n<script>no</script>" });
    for (const path of [
      artifactPath(md.id, 0),
      artifactPath(md.id, 1),
      artifactPath(html.id, 3),
      artifactPath(html.id, 0),
      artifactPath("0".repeat(36), 1),
      "/api/v1/artifact/../vibevalley.yaml",
      `/api/v1/artifact/${html.id}/1x`,
    ])
      expect([path, (await get(path)).status]).toEqual([path, 404]);
  });

  test("is open to a paired device like an attachment, and /mcp still is not", () => {
    expect(remoteMay("GET", artifactPath("01a18349-6451-7525-a49b-7a57810204fb", 2))).toBe(true);
    expect(remoteMay("POST", artifactPath("01a18349-6451-7525-a49b-7a57810204fb", 2))).toBe(false);
    expect(remoteMay("POST", "/api/v1/artifact/list")).toBe(true);
    expect(remoteMay("POST", "/mcp")).toBe(false);
  });
});
