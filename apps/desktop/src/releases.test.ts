import { expect, test } from "vite-plus/test";

import { bundleOf, newer, placeProblem, plistVersion, startsNewFarm } from "./releases";

test("a version is later by its numbers, not its text; one that is not x.y.z is never later", () => {
  expect(newer("0.10.0", "0.9.9")).toBe(true);
  expect(newer("1.0.0", "1.0.0")).toBe(false);
  expect(newer("0.9.9", "0.10.0")).toBe(false);
  expect(newer("1.0.0-beta.1", "0.1.0")).toBe(false);
  expect(newer("0.2.0", "0.0.0")).toBe(true);
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
