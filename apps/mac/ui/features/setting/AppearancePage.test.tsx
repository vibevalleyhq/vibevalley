import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { BizCode } from "@vibevalley/protocol/api";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { buildMonoFontOptions, defaultMonoFonts, fontFamilyStack } from "./AppearancePage";

async function mountAppearance(locale: "en" | "zh", configure?: (fake: FakeHost) => void) {
  setLocale(locale);
  const fake = fakeHost(scenarios.typical, { route: "/settings/appearance", locale });
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:appearance-specimen") === 1);
  return { app, fake };
}

test("buildMonoFontOptions sorts installed host fonts before fallback presets and fontFamilyStack quotes multi-word names", () => {
  expect(fontFamilyStack("Menlo")).toBe("Menlo, 'PingFang SC', Menlo, monospace");
  expect(fontFamilyStack("Maple Mono NF CN")).toBe("'Maple Mono NF CN', 'PingFang SC', Menlo, monospace");

  const options = buildMonoFontOptions(["Zed Mono", "Menlo", "SF Mono", "Andale Mono", "Menlo"], "Custom Mono", {
    installed: "Installed",
    fallback: "Fallback presets",
  });

  const installedValues = options.filter((o) => o.installed).map((o) => o.value);
  const fallbackValues = options.filter((o) => !o.installed).map((o) => o.value);

  expect(installedValues).toEqual(["SF Mono", "Menlo", "Andale Mono", "Zed Mono"]);
  expect(fallbackValues[0]).toBe("Custom Mono");
  expect(fallbackValues).toContain("Maple Mono NF CN");
  expect(options.slice(0, installedValues.length).every((o) => o.group === "Installed")).toBe(true);
  expect(options.slice(installedValues.length).every((o) => o.group === "Fallback presets")).toBe(true);

  const noHostOptions = buildMonoFontOptions([], undefined, { installed: "Installed", fallback: "Fallback presets" });
  expect(noHostOptions.map((o) => o.value)).toEqual([...defaultMonoFonts]);
  expect(noHostOptions.every((o) => !o.installed && o.group === undefined)).toBe(true);
});

test("AppearancePage renders WYSIWYG font selector, installed-first order, search, and live specimen card", async () => {
  const { app, fake } = await mountAppearance("en", (f) => {
    f.respond("host.info", {
      capabilities: ["theme", "motion", "font"],
      theme: "light",
      motion: "off",
      monoFont: "Menlo",
      monoFonts: ["Zed Mono", "Menlo", "SF Mono"],
      terminalFontSize: 13,
      uiFontSize: 13,
    });
    f.respond("host.font", (payload: unknown) => {
      const p = payload as { monoFont?: string; terminalFontSize?: number; uiFontSize?: number };
      return {
        monoFont: p.monoFont ?? "Menlo",
        terminalFontSize: p.terminalFontSize ?? 13,
        uiFontSize: p.uiFontSize ?? 13,
      };
    });
  });

  expect(app.spanStyle("id:mono-font-trigger >> text:Menlo").fontFamily).toContain("Menlo");
  expect(app.texts()).toContain("Menlo · 13pt");
  expect(app.texts()).toContain("100% · 13pt");
  expect(app.texts()).toContain("const check = (x: number) => x !== 0O1lI;");
  expect(app.texts()).toContain("// 中英文等宽对齐：连字与易混淆字符");
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontFamily).toContain("Menlo");
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontSize).toBe(13);
  expect(app.spanStyle("id:appearance-specimen >> text:Bilingual clarity").fontSize).toBe(13);

  await app.press("id:mono-font-trigger");
  await fake.pumpUntil(app, () => app.count("id:mono-font-search") === 1);

  expect(app.count("id:mono-font-option-SF Mono")).toBe(1);
  expect(app.count("id:mono-font-option-Zed Mono")).toBe(1);
  expect(app.spanStyle("id:mono-font-option-SF Mono >> text:SF Mono").fontFamily).toContain("SF Mono");
  expect(app.spanStyle("id:mono-font-option-SF Mono >> text:Aa 01 中文").fontFamily).toContain("SF Mono");
  expect(app.spanStyle("id:mono-font-option-Zed Mono >> text:Zed Mono").fontFamily).toContain("Zed Mono");

  await app.type("id:mono-font-search", "Zed");
  await fake.pumpUntil(app, () => app.count("id:mono-font-option-Menlo") === 0);
  expect(app.count("id:mono-font-option-Zed Mono")).toBe(1);

  await app.press("id:mono-font-option-Zed Mono");
  await fake.pumpUntil(app, () => app.texts().includes("Zed Mono · 13pt"));
  expect(fake.calls.findLast((c) => c.op === "host.font")?.payload).toEqual({ monoFont: "Zed Mono" });
  expect(app.spanStyle("id:mono-font-trigger >> text:Zed Mono").fontFamily).toContain("Zed Mono");
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontFamily).toContain("Zed Mono");

  await app.press("id:terminal-font-size-18");
  await fake.pumpUntil(app, () => app.texts().includes("Zed Mono · 18pt"));
  expect(fake.calls.findLast((c) => c.op === "host.font")?.payload).toEqual({ terminalFontSize: 18 });
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontSize).toBe(18);

  await app.press("id:scale-125");
  await fake.pumpUntil(app, () => app.texts().includes("125% · 16pt"));
  expect(fake.calls.findLast((c) => c.op === "host.font")?.payload).toEqual({ terminalFontSize: 16, uiFontSize: 16 });
  expect(app.spanStyle("id:appearance-specimen >> text:Bilingual clarity").fontSize).toBe(16);
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontSize).toBe(16);
});

test("AppearancePage surfaces host.font errors and reverts failed selection", async () => {
  const { app, fake } = await mountAppearance("en", (f) => {
    f.respond("host.info", {
      capabilities: ["theme", "motion", "font"],
      monoFont: "Menlo",
      monoFonts: ["Menlo", "Monaco"],
      terminalFontSize: 13,
      uiFontSize: 13,
    });
    f.respond("host.font", () => ({ bizCode: BizCode.InternalError, message: "Font registry unavailable" }));
  });

  await app.press("id:terminal-font-size-16");
  await fake.pumpUntil(app, () => app.count("id:appearance-error") === 1);
  expect(app.texts()).toContain("Font registry unavailable");
  expect(app.texts()).toContain("Menlo · 13pt");
  expect(app.spanStyle("id:appearance-specimen >> text:const check").fontSize).toBe(13);
});
