import { expect, test } from "vite-plus/test";

import { bundleOf, manifestFor, newer, placeProblem, plistVersion, stageOf, startsNewFarm } from "./releases";

test("a version is later by its numbers, not its text; one that is not a version is never later", () => {
  expect(newer("0.10.0", "0.9.9")).toBe(true);
  expect(newer("1.0.0", "1.0.0")).toBe(false);
  expect(newer("0.9.9", "0.10.0")).toBe(false);
  expect(newer("0.2.0", "0.0.0")).toBe(true);
  expect(newer("1.0.0-rc.1", "0.1.0")).toBe(false);
});

test("a prerelease comes before its release: alpha, then beta, each by its number", () => {
  const order = ["0.4.0-alpha.1", "0.4.0-alpha.2", "0.4.0-alpha.10", "0.4.0-beta.1", "0.4.0-beta.2", "0.4.0", "0.4.1-alpha.1", "0.4.1"];
  for (const [i, v] of order.entries()) for (const w of order.slice(i + 1)) expect([v, w, newer(w, v), newer(v, w)]).toEqual([v, w, true, false]);
  expect([stageOf("0.4.0"), stageOf("0.4.0-beta.3"), stageOf("0.4.0-alpha.1"), stageOf("0.4")]).toEqual(["stable", "beta", "alpha", undefined]);
});

test("a channel updates to the latest release it takes, never to a draft", () => {
  const listed = (tag: string, draft = false) => ({
    tag_name: tag,
    draft,
    assets: [{ name: "release.json", browser_download_url: `https://example.test/${tag}/release.json` }],
  });
  const list = [listed("v0.5.0-alpha.1", true), listed("v0.4.0-beta.2"), listed("v0.4.0-alpha.3"), listed("v0.3.1"), listed("v0.5.0-alpha.0")];
  expect(manifestFor(list, "stable")).toBe("https://example.test/v0.3.1/release.json");
  expect(manifestFor(list, "beta")).toBe("https://example.test/v0.4.0-beta.2/release.json");
  expect(manifestFor(list, "alpha")).toBe("https://example.test/v0.5.0-alpha.0/release.json");
  expect(manifestFor([listed("v0.4.0-beta.1", true)], "beta")).toBeUndefined();
});

test("the .app is found from its executable, and only one in a place it can be written is replaced", () => {
  expect(bundleOf("/Applications/VibeValley.app/Contents/MacOS/VibeValley")).toBe("/Applications/VibeValley.app");
  expect(bundleOf("/repo/node_modules/electron/dist/Electron")).toBeUndefined();
  expect(placeProblem("/Applications/VibeValley.app", true)).toBeUndefined();
  expect(placeProblem("/Applications/VibeValley.app", false)).toBe("readOnly");
  expect(placeProblem("/Volumes/VibeValley 0.2.0/VibeValley.app", false)).toBe("diskImage");
  expect(placeProblem("/private/var/folders/x/T/AppTranslocation/ABC/d/VibeValley.app", true)).toBe("translocated");
});

test("a release starts a new farm only when there is a farm made from another baseline", () => {
  expect(startsNewFarm("abc", undefined)).toBe(false);
  expect(startsNewFarm("abc", "abc\n")).toBe(false);
  expect(startsNewFarm("abc", "def")).toBe(true);
});

test("the Info.plist's short version is read", () => {
  const xml = "<dict>\n\t<key>CFBundleName</key>\n\t<string>VibeValley</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.2.0</string>\n</dict>";
  expect(plistVersion(xml)).toBe("0.2.0");
  expect(plistVersion("<dict/>")).toBeUndefined();
});
