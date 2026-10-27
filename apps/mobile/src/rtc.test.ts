import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { IRtcEngineEventHandler } from "react-native-agora";
import { nativeRtc } from "./rtc";
import { type FromNative, mobileHost, type RtcEvents } from "@vibevalley/protocol/host";
import { nativeHost } from "./host";

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
  const replies: FromNative[] = [];
  const native = nativeHost((m) => replies.push(m));
  const page = mobileHost((m) => void native.receive(m));
  const heard: string[] = [];
  try {
    const old = page.host.rtc!(grant("old"), events);
    await settle();
    const oldHandler = sdk.handler;
    oldHandler?.onJoinChannelSuccess?.(connection("old"), 0);
    await settle();
    const next = page.host.rtc!(grant("new"), { ...events, joined: () => heard.push("new") });
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    await settle();
    page.receive(replies[1]);
    const current = await next;
    page.receive(replies[0]);
    const late = await old;
    const cleaning = late.leave();
    await settle();
    page.receive(replies[2]);
    await cleaning;
    expect(sdk.release).toHaveBeenCalledTimes(1);

    oldHandler?.onUserJoined?.(connection("old"), 8, 0);
    sdk.handler?.onUserJoined?.(connection("new"), 9, 0);
    await settle();
    expect(replies).toHaveLength(4);
    page.receive(replies[3]);
    expect(heard).toEqual(["new"]);

    const muted = current.mute(true);
    await settle();
    page.receive(replies[4]);
    await muted;
    const renewed = current.renew("fresh");
    await settle();
    page.receive(replies[5]);
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
  const oldReplies: FromNative[] = [];
  const oldPage = nativeHost((m) => oldReplies.push(m));
  const oldJoin = oldPage.receive({ id: 1, call: "rtc.join", line: 1, grant: grant("old") });
  oldPage.close();
  await oldJoin;

  const replies: FromNative[] = [];
  const currentPage = nativeHost((m) => replies.push(m));
  try {
    const current = currentPage.receive({ id: 1, call: "rtc.join", line: 1, grant: grant("new") });
    await settle();
    sdk.handler?.onJoinChannelSuccess?.(connection("new"), 0);
    await current;
    permission.resolve("yes");
    await settle();
    expect(oldReplies).toEqual([]);
    expect(replies).toEqual([{ id: 1, ok: true }]);
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
