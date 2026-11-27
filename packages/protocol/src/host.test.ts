import { expect, test } from "vite-plus/test";

import {
  AppletInstallInput,
  AppletOpenResult,
  AppletRemoveResult,
  CommandLineState,
  HostCapturedImage,
  MotionChoice,
  NoteAppletInfo,
  ThemeChoice,
  type UpdateFailureKind,
  type UpdateManual,
  UpdateState,
} from "./host";

test("UpdateState decodes all variants across JSON round-trips and rejects malformed payloads", () => {
  const manualReasons: readonly UpdateManual[] = ["diskImage", "translocated", "readOnly", "noBuild"];
  const failureKinds: readonly UpdateFailureKind[] = ["network", "rateLimit", "integrity", "signature", "permission", "install", "unknown"];

  const validStates: readonly UpdateState[] = [
    { _tag: "disabled", version: "0.0.0" },
    { _tag: "idle", version: "0.1.0" },
    { _tag: "idle", version: "0.1.0", checkedAt: 1_764_160_800_000 },
    { _tag: "checking", version: "0.1.0" },
    { _tag: "downloading", version: "0.1.0", next: "0.2.0", percent: 42 },
    {
      _tag: "downloading",
      version: "0.1.0",
      next: "0.2.0",
      percent: 42,
      downloadedBytes: 42_000_000,
      totalBytes: 100_000_000,
      speedBps: 3_500_000,
    },
    { _tag: "verifying", version: "0.1.0", next: "0.2.0" },
    {
      _tag: "ready",
      version: "0.1.0",
      next: "0.2.0",
      notes: ["Faster startup", "Resumable downloads"],
      newFarm: false,
      page: "https://vibevalley.dev/releases/v0.2.0",
    },
    { _tag: "installing", version: "0.1.0", next: "0.2.0" },
    ...manualReasons.map((why): UpdateState => ({
      _tag: "manual",
      version: "0.1.0",
      next: "0.2.0",
      why,
      page: "https://vibevalley.dev/releases/v0.2.0",
    })),
    { _tag: "failed", version: "0.1.0", why: "connection reset" },
    ...failureKinds.map((kind): UpdateState => ({
      _tag: "failed",
      version: "0.1.0",
      why: `error:${kind}`,
      kind,
      page: "https://vibevalley.dev/releases",
    })),
  ];

  for (const state of validStates) {
    const roundTripped: unknown = JSON.parse(JSON.stringify(state));
    expect(UpdateState.parse(roundTripped)).toEqual(state);
  }

  const invalidPayloads: readonly unknown[] = [
    { _tag: "disabled" },
    { _tag: "idle", version: "0.1.0", checkedAt: "now" },
    { _tag: "idle", version: "0.1.0", checkedAt: null },
    { _tag: "downloading", version: "0.1.0", percent: 50 },
    { _tag: "downloading", version: "0.1.0", next: "0.2.0", percent: "50" },
    { _tag: "downloading", version: "0.1.0", next: "0.2.0", percent: 50, downloadedBytes: "42" },
    { _tag: "downloading", version: "0.1.0", next: "0.2.0", percent: 50, totalBytes: null },
    { _tag: "downloading", version: "0.1.0", next: "0.2.0", percent: 50, speedBps: "fast" },
    { _tag: "verifying", version: "0.1.0" },
    { _tag: "installing", version: "0.1.0" },
    { _tag: "manual", version: "0.1.0", next: "0.2.0", why: "bogus", page: "" },
    { _tag: "failed", version: "0.1.0", why: "boom", kind: "bogus" },
    { _tag: "failed", version: "0.1.0", why: "boom", kind: null },
    { _tag: "failed", version: "0.1.0", why: "boom", page: 123 },
    { _tag: "unknown", version: "0.1.0" },
  ];

  for (const payload of invalidPayloads) {
    expect(UpdateState.safeParse(payload).success).toBe(false);
  }
});

test("host state schemas decode valid wire payloads and reject malformed shapes", () => {
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
    NoteAppletInfo.parse({
      noteId: "art-1",
      noteType: "base",
      appName: "Metrics",
      bundleId: "dev.vibevalley.applet.art-1",
      bundlePath: "/Users/demo/Applications/VibeValley Apps/Metrics.app",
      alwaysOnTop: true,
      installed: true,
    }).installed,
  ).toBe(true);
  expect(NoteAppletInfo.safeParse({ noteId: "art-1" }).success).toBe(false);

  expect(
    AppletInstallInput.parse({
      noteId: "art-1",
      noteType: "base",
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
