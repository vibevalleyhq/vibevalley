// The catalog (/catalog) on the workbench fixture: the sprites by shelf from
// the bundled manifest, search, one picture's detail and its frames, the
// cursors; headless, so pictures are not drawn, only laid out.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string, width = 1400) {
  const fake = fakeHost({ state, responses }, { route });
  const app = await open("./main.tsx", { width, height: 900, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  return { app, fake };
}

test("the shelves, a shelf, a search", async () => {
  const { app, fake } = await start("/catalog");
  expect(app.count("id:catalog-shelves")).toBe(1);
  expect(fake.calls.map((c) => c.op)).toContain("host.pixelDir");
  const all = app.count("id:picture");
  expect(all).toBeGreaterThan(700);
  await app.press("id:shelf-dog");
  // Hundreds of tiles go: the page lays out again after the press returns.
  await app.waitUntil(() => app.count("id:picture") < all);
  expect(app.count("id:picture")).toBe(12);
  await app.press("id:shelf-all");
  await app.waitUntil(() => app.count("id:picture") === all);
  await app.type("id:catalog-search", "tractor");
  await app.waitUntil(() => app.count("id:picture") < all);
  expect(app.count("id:picture")).toBe(1);
});

test("a picture's detail: marks, frames that play, where it was cut from", async () => {
  const { app } = await start("/catalog/bear-farmer-down");
  expect(app.count("id:picture-detail")).toBe(1);
  expect(app.texts().join(" ")).toContain("design/pixel/raw/char-bear.png");
  expect(app.texts().join(" ")).toContain("design/pixel/gen.sh char-bear");
  expect(app.count("id:play")).toBe(1);
});

test("the cursors", async () => {
  const { app } = await start("/catalog/cursors");
  expect(app.count("id:cursor")).toBeGreaterThan(3);
});

test("the sounds: a press renders the recipe and hands the host a WAV", async () => {
  const { app, fake } = await start("/catalog/sounds");
  expect(app.count("id:sound")).toBe(29);
  await app.type("id:catalog-search", "coin");
  await app.waitUntil(() => app.count("id:sound") === 1);
  await app.press("id:sound");
  await fake.pump(app);
  const play = fake.calls.find((c) => c.op === "host.playAudio")?.payload as { data: string; type: string } | undefined;
  expect(play?.type).toBe("audio/wav");
  expect(atob(play?.data ?? "").slice(0, 4)).toBe("RIFF");
});
