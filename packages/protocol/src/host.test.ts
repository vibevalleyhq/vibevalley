import { expect, test } from "vite-plus/test";

import {
  AppletInstallInput,
  AppletOpenResult,
  AppletRemoveResult,
  ArtifactAppletInfo,
  CommandLineState,
  HostCapturedImage,
  MotionChoice,
  ThemeChoice,
  UpdateState,
} from "./host";

test("host state schemas decode valid wire payloads and reject malformed shapes", () => {
  expect(
    UpdateState.parse({
      _tag: "ready",
      version: "0.1.0",
      next: "0.2.0",
      notes: ["Faster startup"],
      newFarm: false,
      page: "https://vibevalley.dev",
    })._tag,
  ).toBe("ready");
  expect(UpdateState.safeParse({ _tag: "manual", version: "0.1.0", next: "0.2.0", why: "bogus", page: "" }).success).toBe(false);

  expect(
    CommandLineState.parse({
      command: "vibevalley",
      link: "/usr/local/bin/vibevalley",
      installed: true,
      onPath: true,
      taken: false,
    }).installed,
  ).toBe(true);

  expect(ThemeChoice.parse("system")).toBe("system");
  expect(ThemeChoice.safeParse("sepia").success).toBe(false);

  expect(MotionChoice.parse("off")).toBe("off");
  expect(MotionChoice.parse("on")).toBe("on");
  expect(MotionChoice.parse("system")).toBe("system");
  expect(MotionChoice.safeParse("reduced").success).toBe(false);

  expect(
    ArtifactAppletInfo.parse({
      artifactId: "art-1",
      artifactType: "dashboard",
      appName: "Metrics",
      bundleId: "dev.vibevalley.applet.art-1",
      bundlePath: "/Users/demo/Applications/VibeValley Apps/Metrics.app",
      alwaysOnTop: true,
      installed: true,
    }).installed,
  ).toBe(true);
  expect(ArtifactAppletInfo.safeParse({ artifactId: "art-1" }).success).toBe(false);

  expect(
    AppletInstallInput.parse({
      artifactId: "art-1",
      artifactType: "dashboard",
      appName: "Metrics",
      alwaysOnTop: false,
    }).appName,
  ).toBe("Metrics");
  expect(AppletRemoveResult.parse({ removed: true }).removed).toBe(true);
  expect(AppletOpenResult.parse({ opened: true }).opened).toBe(true);
  expect(
    HostCapturedImage.parse({
      mime: "image/png",
      data: "iVBORw0KGgo=",
      width: 640,
      height: 400,
    }).width,
  ).toBe(640);
  expect(HostCapturedImage.safeParse({ mime: "image/png" }).success).toBe(false);
});
