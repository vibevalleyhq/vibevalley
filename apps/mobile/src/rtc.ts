// Agora exposes one native engine. Each attempt owns it until it ends; late permission replies and callbacks from an
// ended attempt cannot initialize, release or send events through its successor.

import { t } from "@vibevalley/i18n";

import {
  ChannelProfileType,
  ClientRoleType,
  ConnectionStateType,
  createAgoraRtcEngine,
  type IRtcEngine,
  type IRtcEngineEventHandler,
  type RtcConnection,
} from "react-native-agora";
import { PermissionsAndroid, Platform } from "react-native";
import type { Rtc, RtcLine } from "@vibevalley/protocol/host";
import { level } from "./pairing";

const fail = (code: number, what: string) => {
  if (code < 0) throw new Error(t("mobile.agora", { what, code }));
};

let releaseCurrent: (() => void) | undefined;

export function nativeRtc() {
  let stop: (() => void) | undefined;
  const join: Rtc = (grant, events) => {
    releaseCurrent?.();
    let engine: IRtcEngine | undefined;
    let handler: IRtcEngineEventHandler | undefined;
    let closed = false;
    let joined = false;
    const owns = (connection: RtcConnection) => !closed && connection.channelId === grant.channel && connection.localUid === Number(grant.uid);
    let resolveJoin!: (line: RtcLine) => void;
    let rejectJoin!: (reason: Error) => void;
    const ready = new Promise<RtcLine>((resolve, reject) => {
      resolveJoin = resolve;
      rejectJoin = reject;
    });
    const close = (reason = new Error(t("mobile.callEnded"))) => {
      if (closed) return;
      closed = true;
      if (stop === close) stop = undefined;
      if (releaseCurrent === close) releaseCurrent = undefined;
      rejectJoin(reason);
      if (!engine) return;
      if (handler) engine.unregisterEventHandler(handler);
      engine.leaveChannel();
      engine.release();
    };
    stop = close;
    releaseCurrent = close;
    const line: RtcLine = {
      mute: async (on) => {
        if (closed || !engine) throw new Error(t("mobile.callEnded"));
        fail(engine.muteLocalAudioStream(on), on ? t("mobile.step.mute") : t("mobile.step.unmute"));
      },
      renew: async (token) => {
        if (closed || !engine) throw new Error(t("mobile.callEnded"));
        fail(engine.renewToken(token), t("mobile.step.renew"));
      },
      leave: async () => close(),
    };
    void (async () => {
      try {
        if (Platform.OS === "android" && (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) !== PermissionsAndroid.RESULTS.GRANTED)
          throw new Error(t("mobile.noMic"));
        if (closed) return;
        engine = createAgoraRtcEngine();
        fail(engine.initialize({ appId: grant.appId, channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting }), t("mobile.step.initialize"));
        handler = {
          onJoinChannelSuccess: (connection) => {
            if (!owns(connection)) return;
            joined = true;
            resolveJoin(line);
          },
          onUserJoined: (connection) => owns(connection) && events.joined(),
          onUserOffline: (connection) => owns(connection) && events.left(),
          onStreamMessage: (connection, _uid, _stream, data) => owns(connection) && events.stream(new TextDecoder().decode(data)),
          onAudioVolumeIndication: (connection, speakers) => {
            if (!owns(connection)) return;
            let mine = 0;
            let theirs = 0;
            // uid 0 is this phone.
            for (const s of speakers) {
              if (s.uid == null || s.uid === 0) mine = level(s.volume);
              else theirs = level(s.volume);
            }
            events.levels(mine, theirs);
          },
          // onError has no connection identity; queued errors from a released engine cannot end this attempt.
          onConnectionStateChanged: (connection, state, reason) => {
            if (!owns(connection) || state !== ConnectionStateType.ConnectionStateFailed) return;
            const text = t("mobile.agoraLost", { reason });
            if (!joined) close(new Error(text));
            else events.problem(text);
          },
          onTokenPrivilegeWillExpire: (connection) => owns(connection) && events.expiring(),
        };
        engine.registerEventHandler(handler);
        fail(engine.enableAudio(), t("mobile.step.mic"));
        fail(engine.enableAudioVolumeIndication(200, 3, true), t("mobile.step.volume"));
        // The agent listens only to the numeric uid in the grant.
        fail(
          engine.joinChannel(grant.token, grant.channel, Number(grant.uid), {
            clientRoleType: ClientRoleType.ClientRoleBroadcaster,
            channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting,
            publishMicrophoneTrack: true,
            autoSubscribeAudio: true,
          }),
          t("mobile.step.join"),
        );
      } catch (e) {
        close(e instanceof Error ? e : new Error(String(e)));
      }
    })();
    return ready;
  };
  return { join, close: () => stop?.() };
}
