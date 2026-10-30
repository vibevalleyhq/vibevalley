import type { IRtcEngineEventHandler } from "react-native-agora";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { BridgeMessage, Link } from "@vibevalley/bridge";
import { mobileHost, type RtcEvents } from "@vibevalley/protocol/host";

import { nativeHost } from "./host";
import { nativeRtc } from "./rtc";

const sdk = vi.hoisted(() => ({
  request: vi.fn<() => Promise<string>>(),
  initialize: vi.fn(() => 0),
  release: vi.fn(),
  mute: vi.fn(() => 0),
  renew: vi.fn(() => 0),
  handler: undefined as IRtcEngineEventHandler | undefined,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  PermissionsAndroid: { request: sdk.request, PERMISSIONS: { RECORD_AUDIO: "mic" }, RESULTS: { GRANTED: "yes" } },
}));
vi.mock("./notify", () => ({ notify: async () => undefined }));
vi.mock("react-native-agora", () => ({
  ChannelProfileType: { ChannelProfileLiveBroadcasting: 1 },
  ClientRoleType: { ClientRoleBroadcaster: 1 },
  ConnectionStateType: { ConnectionStateFailed: 5 },
  createAgoraRtcEngine: () => ({
    initialize: sdk.initialize,
    release: sdk.release,
    registerEventHandler: (handler: IRtcEngineEventHandler) => (sdk.handler = handler),
    unregisterEventHandler: () => undefined,
    enableAudio: () => 0,
    enableAudioVolumeIndication: () => 0,
    joinChannel: () => 0,
    leaveChannel: () => 0,
    muteLocalAudioStream: sdk.mute,
    renewToken: sdk.renew,
  }),
}));

let rtc = nativeRtc();
beforeEach(() => {
  rtc.close();
  rtc = nativeRtc();
  vi.clearAllMocks();
  sdk.handler = undefined;
  sdk.request.mockResolvedValue("yes");
});
afterEach(() => rtc.close());

const grant = (channel: string) => ({ appId: "a", channel, uid: "7", token: "t" });
const connection = (channel: string) => ({ channelId: channel, localUid: 7 });
const events: RtcEvents = { joined() {}, left() {}, stream() {}, levels() {}, problem() {}, expiring() {} };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The shell's messages are held in replies until deliver hands one to the page; the page's calls (ask) reach the shell at once. */
function held() {
  const toShell = new Set<(m: unknown) => void>();
  const toPage = new Set<(m: unknown) => void>();
  const copy = (m: BridgeMessage): unknown => JSON.parse(JSON.stringify(m));
  const ear = (set: Set<(m: unknown) => void>) => (fn: (m: unknown) => void) => {
    set.add(fn);
    return () => void set.delete(fn);
  };
  const replies: unknown[] = [];
  const ask = (m: BridgeMessage) => {
    for (const fn of toShell) fn(copy(m));
  };
  const page: Link = { send: ask, receive: ear(toPage) };
  const shell: Link = { send: (m) => replies.push(copy(m)), receive: ear(toShell) };
  const deliver = (m: unknown) => {
    for (const fn of toPage) fn(m);
  };
  return { page, shell, replies, deliver, ask };
}

test("an older microphone permission reply cannot replace a newer call", async () => {
  const permission = Promise.withResolvers<string>();
  sdk.request.mockReturnValueOnce(permission.promise);
  void rtc.join(grant("old"), events).catch(() => undefined);
  const nextPage = nativeRtc();
  try {
    const current = nextPage.join(grant("new"), events);
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    await current;
    rtc.close();
    permission.resolve("yes");
    await settle();
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
    expect(sdk.release).not.toHaveBeenCalled();
  } finally {
    nextPage.close();
  }
});

test("a rejected join releases its microphone and engine", async () => {
  const joining = rtc.join(grant("failed"), events);
  const rejected = expect(joining).rejects.toThrow("声网");
  await settle();
  sdk.handler?.onConnectionStateChanged?.(connection("failed"), 5, 4);
  await rejected;
  expect(sdk.release).toHaveBeenCalledTimes(1);
});

test("late cleanup and native events from an old line cannot affect its successor across the bridge", async () => {
  const { page: pageLink, shell, replies, deliver } = held();
  const native = nativeHost(shell);
  const page = mobileHost(pageLink);
  const heard: string[] = [];
  try {
    const old = page.rtc!(grant("old"), events);
    await settle();
    const oldHandler = sdk.handler;
    oldHandler?.onJoinChannelSuccess?.(connection("old"), 0);
    await settle();
    const next = page.rtc!(grant("new"), { ...events, joined: () => heard.push("new") });
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    await settle();
    deliver(replies[1]);
    const current = await next;
    deliver(replies[0]);
    const late = await old;
    const cleaning = late.leave();
    await settle();
    deliver(replies[2]);
    await cleaning;
    expect(sdk.release).toHaveBeenCalledTimes(1);

    oldHandler?.onUserJoined?.(connection("old"), 8, 0);
    sdk.handler?.onUserJoined?.(connection("new"), 9, 0);
    await settle();
    expect(replies).toHaveLength(4);
    deliver(replies[3]);
    expect(heard).toEqual(["new"]);

    const muted = current.mute(true);
    await settle();
    deliver(replies[4]);
    await muted;
    const renewed = current.renew("fresh");
    await settle();
    deliver(replies[5]);
    await renewed;
    expect(sdk.mute).toHaveBeenCalledWith(true);
    expect(sdk.renew).toHaveBeenCalledWith("fresh");
  } finally {
    native.close();
  }
  expect(sdk.release).toHaveBeenCalledTimes(2);
});

test("closing a page cancels its pending join and silences replies before a new page opens", async () => {
  const permission = Promise.withResolvers<string>();
  sdk.request.mockReturnValueOnce(permission.promise);
  const before = held();
  const oldPage = nativeHost(before.shell);
  before.ask({ id: 1, call: "rtcJoin", input: { line: 1, grant: grant("old") } });
  oldPage.close();
  await settle();

  const now = held();
  const currentPage = nativeHost(now.shell);
  try {
    now.ask({ id: 1, call: "rtcJoin", input: { line: 1, grant: grant("new") } });
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    await settle();
    permission.resolve("yes");
    await settle();
    expect(before.replies).toEqual([]);
    expect(now.replies).toEqual([{ id: 1, ok: true }]);
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
    expect(sdk.release).not.toHaveBeenCalled();
  } finally {
    currentPage.close();
  }
  expect(sdk.release).toHaveBeenCalledTimes(1);
});

test("the singleton SDK's current handler ignores queued events for a previous connection", async () => {
  const heard: string[] = [];
  const old = rtc.join(grant("old"), events);
  await settle();
  sdk.handler?.onJoinChannelSuccess?.(connection("old"), 0);
  await old;
  let connected = false;
  const current = rtc.join(grant("new"), { ...events, stream: (text) => heard.push(text), expiring: () => heard.push("renew") });
  void current.then(() => (connected = true));
  await settle();
  // IrisApiEngine dispatches queued native payloads to the current handler registry.
  sdk.handler?.onJoinChannelSuccess?.(connection("old"), 0);
  sdk.handler?.onJoinChannelSuccess?.({ channelId: "new", localUid: 8 }, 0);
  sdk.handler?.onStreamMessage?.(connection("old"), 9, 1, new TextEncoder().encode("old caption"), 11, 0);
  sdk.handler?.onTokenPrivilegeWillExpire?.(connection("old"), "old token");
  sdk.handler?.onConnectionStateChanged?.(connection("old"), 5, 4);
  await settle();
  expect(connected).toBe(false);
  expect(heard).toEqual([]);
  sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
  await current;
  sdk.handler?.onStreamMessage?.(connection("new"), 9, 1, new TextEncoder().encode("new caption"), 11, 0);
  expect(heard).toEqual(["new caption"]);
});

test("an SDK error without connection identity cannot terminate a pending call", async () => {
  let rejected = false;
  const current = rtc.join(grant("new"), events);
  void current.catch(() => (rejected = true));
  await settle();
  sdk.handler?.onError?.(1, "old engine error");
  await settle();
  expect(rejected).toBe(false);
  expect(sdk.release).not.toHaveBeenCalled();
  sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
  await current;
});

test("a new page owns the singleton engine even when the old page closes afterward", async () => {
  const oldPage = nativeRtc();
  const newPage = nativeRtc();
  try {
    const old = oldPage.join(grant("old"), events);
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("old"), 0);
    await old;
    const current = newPage.join(grant("new"), events);
    void current.catch(() => undefined);
    await settle();
    expect(sdk.release).toHaveBeenCalledTimes(1);
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    const line = await current;
    oldPage.close();
    expect(sdk.release).toHaveBeenCalledTimes(1);
    await line.mute(true);
    expect(sdk.mute).toHaveBeenCalledWith(true);
  } finally {
    oldPage.close();
    newPage.close();
  }
  expect(sdk.release).toHaveBeenCalledTimes(2);
});
