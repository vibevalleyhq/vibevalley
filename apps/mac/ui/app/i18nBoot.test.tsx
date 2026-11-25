import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";

test("regression: i18nBoot runs before static UI module imports so module-level t() resolves in host locale", async () => {
  setLocale("zh");
  const zhIssues = t("web.base.place.issues.label");
  setLocale("en");
  const enIssues = t("web.base.place.issues.label");
  const enContent = t("web.base.place.content.label");
  const enSettings = t("web.base.place.settings.label");
  const enTodo = t("web.issue.boardLabels.lane.todo");
  const enGeneral = t("web.setting.nav.general");
  expect(enIssues).not.toBe(zhIssues);
  expect(enIssues).not.toContain("web.");

  const fake = fakeHost(scenarios.typical, { view: "vv", route: "/issues", locale: "en" });
  const app = await open("../App.story.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);

  const issuesTexts = app.texts();
  expect(issuesTexts).toContain(enIssues);
  expect(issuesTexts).toContain(enContent);
  expect(issuesTexts).toContain(enSettings);
  expect(issuesTexts).toContain(enTodo);
  expect(issuesTexts).not.toContain(zhIssues);
  expect(issuesTexts.filter((s) => /^(?:web|shared)\.[a-z]/u.test(s))).toEqual([]);

  await app.host.send("route", "/settings");
  await fake.pump(app);
  await fake.pump(app);

  const settingsTexts = app.texts();
  expect(settingsTexts).toContain(enGeneral);
  expect(settingsTexts.filter((s) => /^(?:web|shared)\.[a-z]/u.test(s))).toEqual([]);
});
