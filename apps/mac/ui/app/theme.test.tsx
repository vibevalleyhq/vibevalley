import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import themeJson from "../design/theme.json";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";
import { fakeHost } from "./fakeHost";

function normHex(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^#/u, "");
  if (hex.length === 3) {
    const [r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}ff`;
  }
  if (hex.length === 4) {
    const [r, g, b, a] = hex;
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
  }
  if (hex.length === 6) return `#${hex}ff`;
  if (hex.length === 8) return `#${hex}`;
  throw new Error(`unexpected hex color: ${raw}`);
}

const lightTokens = themeJson.cssVars.light;
const darkTokens = themeJson.cssVars.dark;

test("workbench surfaces and text inks resolve to theme.json tokens in both light and dark modes", async () => {
  const fake = fakeHost(scenarios.typical, { route: "/issues" });
  const app = await open("./main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  expect(app.viewStyle("id:workbench-page")?.backgroundColor).toBe(normHex(lightTokens.page));
  expect(app.viewStyle("id:rail")?.backgroundColor).toBe(normHex(lightTokens.rail));
  expect(app.viewStyle("id:lane-todo")?.backgroundColor).toBe(normHex(lightTokens.side));
  expect(app.viewStyle("id:issue-card >> nth=0")?.backgroundColor).toBe(normHex(lightTokens.elevated));
  expect(app.spanStyle("id:desk >> text:任务").color).toBe(normHex(lightTokens.ink));
  expect(app.spanStyle("id:lane-todo >> text:3").color).toBe(normHex(lightTokens.muted));

  await app.host.send("route", "/issues/i18");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.viewStyle("id:issue-inspector")?.backgroundColor).toBe(normHex(lightTokens.side));

  await app.setColorScheme("dark");

  expect(app.viewStyle("id:workbench-page")?.backgroundColor).toBe(normHex(darkTokens.page));
  expect(app.viewStyle("id:rail")?.backgroundColor).toBe(normHex(darkTokens.rail));
  expect(app.viewStyle("id:issue-inspector")?.backgroundColor).toBe(normHex(darkTokens.side));
  expect(app.spanStyle("id:desk >> text:任务").color).toBe(normHex(darkTokens.ink));

  await app.host.send("route", "/issues");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.viewStyle("id:lane-todo")?.backgroundColor).toBe(normHex(darkTokens.side));
  expect(app.viewStyle("id:issue-card >> nth=0")?.backgroundColor).toBe(normHex(darkTokens.elevated));
  expect(app.spanStyle("id:lane-todo >> text:3").color).toBe(normHex(darkTokens.muted));

  expect(normHex(lightTokens.page)).not.toBe(normHex(darkTokens.page));
  expect(normHex(lightTokens.side)).not.toBe(normHex(darkTokens.side));
  expect(normHex(lightTokens.rail)).not.toBe(normHex(darkTokens.rail));
  expect(normHex(lightTokens.elevated)).not.toBe(normHex(darkTokens.elevated));
  expect(normHex(lightTokens.ink)).not.toBe(normHex(darkTokens.ink));
});

test("workspace palette and inspector surfaces resolve to identical theme.json tokens in light and dark modes", async () => {
  const pixelDir = decodeURI(new URL("../../../../assets/pixel", import.meta.url).pathname);
  let paletteRev = 0;

  const paletteApp = await open("../App.story.tsx", {
    width: 640,
    height: 420,
    colorScheme: "light",
    platform: "macos",
    host: {
      params: { view: "palette", pixelDir },
      handlers: { action: null, ready: null },
    },
  });
  await paletteApp.host.send("frame:palette", {
    rev: ++paletteRev,
    data: { mode: "commands", query: "", loading: false, note: null, items: [{ id: "c1", label: "Open workspace" }] },
  });
  expect(paletteApp.viewStyle("id:palette-root")?.backgroundColor).toBe(normHex(lightTokens.elevated));
  expect(paletteApp.spanStyle("id:palette-root >> text:Open workspace").color).toBe(normHex(lightTokens.ink));

  await paletteApp.setColorScheme("dark");
  expect(paletteApp.viewStyle("id:palette-root")?.backgroundColor).toBe(normHex(darkTokens.elevated));
  expect(paletteApp.spanStyle("id:palette-root >> text:Open workspace").color).toBe(normHex(darkTokens.ink));

  const inspectorApp = await open("../App.story.tsx", {
    width: 320,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    host: {
      params: { view: "sidebar", role: "inspector", pixelDir },
      handlers: { action: null, ready: null },
    },
  });
  expect(inspectorApp.viewStyle("id:workspace-inspector")?.backgroundColor).toBe(normHex(lightTokens.side));

  await inspectorApp.setColorScheme("dark");
  expect(inspectorApp.viewStyle("id:workspace-inspector")?.backgroundColor).toBe(normHex(darkTokens.side));
});
