// The phone's own call line (@vibevalley/host's rtc): Agora's native SDK, which goes on with the screen locked (the app
// keeps an audio background mode, app.json). The page questions over the bridge; what the call hears goes back as events.

import { ChannelProfileType, ClientRoleType, createAgoraRtcEngine, type IRtcEngine, type IRtcEngineEventHandler } from "react-native-agora";
import { PermissionsAndroid, Platform } from "react-native";
import type { FromNative, RtcGrant } from "@vibevalley/host";
import { level } from "./rules";

let engine: IRtcEngine | undefined;
let handler: IRtcEngineEventHandler | undefined;

const fail = (code: number, what: string) => {
  if (code < 0) throw new Error(`声网：${what}失败（${code}）`);
};

/** Joins with the grant; events go to send until leave. iOS questions for the microphone itself (app.json says why). */
export async function join(grant: RtcGrant, send: (m: FromNative) => void): Promise<void> {
  if (Platform.OS === "android" && (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) !== PermissionsAndroid.RESULTS.GRANTED)
    throw new Error("没有麦克风权限");
  leave();
  const e = createAgoraRtcEngine();
  engine = e;
  fail(e.initialize({ appId: grant.appId, channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting }), "初始化");
  return new Promise((resolve, reject) => {
    let joined = false;
    handler = {
      onJoinChannelSuccess: () => {
        joined = true;
        resolve();
      },
      onUserJoined: () => send({ event: "rtc.joined" }),
      onUserOffline: () => send({ event: "rtc.left" }),
      onStreamMessage: (_c, _uid, _stream, data) => send({ event: "rtc.stream", text: new TextDecoder().decode(data) }),
      onAudioVolumeIndication: (_c, speakers) => {
        let mine = 0;
        let theirs = 0;
        // uid 0 is this phone.
        for (const s of speakers) {
          if (!s.uid) mine = level(s.volume);
          else theirs = level(s.volume);
        }
        send({ event: "rtc.levels", mine, theirs });
      },
      onError: (code, msg) => {
        if (!joined) return reject(new Error(`声网：${code} ${msg}`));
        send({ event: "rtc.problem", text: `声网：${code} ${msg}` });
      },
      onTokenPrivilegeWillExpire: () => send({ event: "rtc.expiring" }),
    };
    e.registerEventHandler(handler);
    e.enableAudio();
    e.enableAudioVolumeIndication(200, 3, true);
    // Joined with the number the uid string holds: the agent listens to that uid only.
    const code = e.joinChannel(grant.token, grant.channel, Number(grant.uid), {
      clientRoleType: ClientRoleType.ClientRoleBroadcaster,
      channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting,
      publishMicrophoneTrack: true,
      autoSubscribeAudio: true,
    });
    if (code < 0) {
      leave();
      reject(new Error(`声网：加入频道失败（${code}）`));
    }
  });
}

export function mute(on: boolean) {
  fail(engine?.muteLocalAudioStream(on) ?? 0, on ? "静音" : "取消静音");
}

export function renew(token: string) {
  fail(engine?.renewToken(token) ?? 0, "续期");
}

export function leave() {
  const e = engine;
  engine = undefined;
  if (!e) return;
  if (handler) e.unregisterEventHandler(handler);
  handler = undefined;
  e.leaveChannel();
  e.release();
}
