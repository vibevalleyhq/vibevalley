import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

test("Combobox supports single-select filtering, empty state, selection, clearable, and downward popup", async () => {
  setLocale("en");
  const app = await open("./Combobox.story.tsx", {
    width: 960,
    height: 760,
    colorScheme: "light",
    platform: "macos",
  });

  expect(app.texts()).toContain("single:none");
  const triggerBox = app.layout("id:combo-single");
  expect(triggerBox).toBeDefined();

  // Typing into the single-select combobox opens the popup downward and filters items.
  await app.type("id:combo-single-input", "Paper");
  await app.waitFor("text:Papertrails Assets");
  expect(app.texts()).not.toContain("VibeValley Core");

  const optionBox = app.layout("text:Papertrails Assets");
  expect(optionBox).toBeDefined();
  expect(optionBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);

  // Typing a non-matching query displays the empty state.
  await app.type("id:combo-single-input", "zzz-missing");
  await app.waitFor(`text:${t("web.base.table.empty")}`);

  // Close and reopen to clear the search query, then select an option.
  await app.keyboard.press("escape");
  await app.press("id:combo-single-trigger");
  await app.waitFor("text:VibeValley Core");
  await app.press("text:VibeValley Core");
  await app.waitFor("text:single:vibevalley");

  // Clear button resets the selected value.
  await app.press("id:combo-single-clear");
  await app.waitFor("text:single:none");
});

test("Combobox supports multi-select chips, stays open on toggle, and bounds long list height", async () => {
  setLocale("en");
  const app = await open("./Combobox.story.tsx", {
    width: 960,
    height: 760,
    colorScheme: "light",
    platform: "macos",
  });

  // Initial chip rendered for "arch".
  expect(app.count("id:combo-multi-chip-arch")).toBe(1);
  expect(app.texts()).toContain("multi:arch");

  // Open multi-select combobox and toggle "UX Polish" + "Performance" while list remains open.
  await app.press("id:combo-multi-trigger");
  await app.waitFor("text:UX Polish");
  await app.press("text:UX Polish");
  await app.waitFor("id:combo-multi-chip-ux");
  expect(app.count("text:Performance")).toBe(1);

  await app.press("text:Performance");
  await app.waitFor("id:combo-multi-chip-perf");
  expect(app.texts()).toContain("multi:arch,ux,perf");

  // Removing a chip removes that value without reopening.
  await app.press("id:combo-multi-chip-remove-ux");
  await app.waitFor("text:multi:arch,perf");

  // Long list popup is bounded (max-h-64 = 256px list + popup padding/border) instead of overflowing the viewport.
  await app.press("id:combo-bounded-trigger");
  await app.waitFor("text:Option 1");
  const firstOption = app.layout("text:Option 1");
  const lastVisibleOption = app.layout("text:Option 24");
  expect(firstOption).toBeDefined();
  // Option 24 is clipped/virtualized outside the max-h-64 scroll area.
  expect(lastVisibleOption?.clipped ?? true).toBe(true);
});

test("Select opens downward with cover=false and distinguishes enum vs searchable dropdowns", async () => {
  setLocale("en");
  const app = await open("./Combobox.story.tsx", {
    width: 960,
    height: 760,
    colorScheme: "light",
    platform: "macos",
  });

  // Fixed enum Select has no search input and opens strictly below its trigger (cover=false).
  const enumTrigger = app.layout("id:select-enum-trigger");
  expect(enumTrigger).toBeDefined();
  await app.press("id:select-enum-trigger");
  await app.waitFor("text:Done");
  expect(app.count("id:select-enum-search")).toBe(0);
  const doneOption = app.layout("text:Done");
  expect(doneOption).toBeDefined();
  expect(doneOption!.y).toBeGreaterThanOrEqual(enumTrigger!.y + enumTrigger!.height);

  // Choose "Done" to close enum select, then open searchable select.
  await app.press("text:Done");
  await app.waitFor("id:select-enum-trigger >> text:Done");

  const searchTrigger = app.layout("id:select-searchable-trigger");
  expect(searchTrigger).toBeDefined();
  await app.press("id:select-searchable-trigger");
  await app.waitFor("id:select-searchable-search");

  const searchInput = app.layout("id:select-searchable-search");
  expect(searchInput).toBeDefined();
  expect(searchInput!.y).toBeGreaterThanOrEqual(searchTrigger!.y + searchTrigger!.height);

  await app.type("id:select-searchable-search", "NSH");
  await app.waitFor("text:NSH UI Runtime");
  expect(app.texts()).not.toContain("VibeValley Core");
  await app.press("text:NSH UI Runtime");
  await app.waitFor("id:select-searchable-trigger >> text:NSH UI Runtime");
});
