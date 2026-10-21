// A call's line on Agora's Web SDK, loaded when a call starts: the page's own, where the host carries none (the desktop,
// a browser). The phone's shell carries its own (@vibevalley/host's rtc), which goes on with the screen locked.

import type { Rtc } from "@vibevalley/host";

export const webRtc: Rtc = async (grant, on) => {
  const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
  AgoraRTC.setLogLevel(3);
  const client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
  let gone = false;
  client.on("user-joined", () => !gone && on.joined());
  client.on("user-left", () => !gone && on.left());
  client.on("user-published", async (user, media) => {
    if (gone || media !== "audio") return;
    await client.subscribe(user, "audio");
    user.audioTrack?.play();
  });
  client.on("stream-message", (_uid: unknown, payload: Uint8Array) => !gone && on.stream(new TextDecoder().decode(payload)));
  client.on("volume-indicator", (levels: { uid: string | number; level: number }[]) => {
    if (gone) return;
    let mine = 0;
    let theirs = 0;
    for (const l of levels) {
      if (String(l.uid) === grant.uid) mine = l.level;
      else theirs = l.level;
    }
    on.levels(mine, theirs);
  });
  client.on("exception", (e: { code: number; msg: string }) => !gone && on.problem(`声网：${e.code} ${e.msg}`));
  client.on("token-privilege-will-expire", () => !gone && on.expiring());
  const leave = async () => {
    gone = true;
    mic?.close();
    await client.leave().catch(() => undefined);
  };
  let mic: Awaited<ReturnType<typeof AgoraRTC.createMicrophoneAudioTrack>> | undefined;
  try {
    await client.setClientRole("host");
    client.enableAudioVolumeIndicator();
    // Joined with the number the uid string holds: the agent listens to that uid only.
    await client.join(grant.appId, grant.channel, grant.token, Number(grant.uid));
    // Echo cancellation, noise suppression and gain on, as a quiet laptop microphone otherwise reaches the agent too
    // quietly for its voice detection to hear anyone talk.
    mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    await client.publish(mic);
  } catch (e) {
    await leave();
    throw e;
  }
  return {
    mute: async (on) => {
      await mic?.setMuted(on);
    },
    renew: (token) => client.renewToken(token),
    leave,
  };
};
