import {
  Experimental_AbstractRealtimeSession,
  type Experimental_RealtimeModel,
  type Experimental_RealtimeServerEvent,
  type Experimental_RealtimeState,
} from "ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { Playback } from "./playback.ts";

class Session extends Experimental_AbstractRealtimeSession {
  protected setState<K extends keyof Experimental_RealtimeState>(key: K, value: Experimental_RealtimeState[K]): void {
    this.state[key] = value;
  }
  get status() {
    return this.state.status;
  }
}

const probe = (delegationMode: "client" | "provider") => {
  const send = vi.fn(async () => {});
  const stop = vi.fn();
  const dispose = vi.fn();
  const errors: Error[] = [];
  const channel: {
    receive?: (event: Experimental_RealtimeServerEvent) => void | Promise<void>;
    playing?: (playing: boolean) => void;
  } = {};
  const model: Experimental_RealtimeModel = {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture",
    capabilities: { conversation: "continuous", transports: ["websocket"], connections: ["provider"], startup: "session-start" },
    parseServerEvent: () => [],
    serializeClientEvent: (event) => event,
    buildSessionConfig: (config) => config,
    createTransport: (callbacks) => {
      channel.receive = callbacks.onEvent;
      channel.playing = callbacks.onPlaying;
      return {
        connect: async () => {
          await callbacks.onEvent({ type: "session-started", sessionId: "fixture", delegationMode, raw: {} });
        },
        sendEvent: send,
        startCapture: async () => {},
        stopCapture: async () => {},
        stopPlayback: stop,
        resumePlayback: async () => {},
        finish: async () => {},
        close: async () => {},
        dispose,
      };
    },
  };
  const session = new Session({ model, api: { provider: "/fixture" }, onError: (error) => errors.push(error) });
  return { session, channel, send, stop, dispose, errors };
};

describe("SDK realtime boundary", () => {
  it("leaves tagged run completion and sample-accurate cuts to the custom transport", async () => {
    const p = probe("client");
    try {
      await p.session.connect({ capture: false });
      expect(p.session.status).toBe("connected");
      await p.channel.receive?.({ type: "audio-chunk", delta: "AAAAAA==", raw: { run_id: "r1", turn_id: "t1" } });
      p.channel.playing?.(true);
      p.channel.playing?.(false);
      p.session.stopPlayback();
      expect(p.stop).toHaveBeenCalledExactlyOnceWith();
      expect(p.send).not.toHaveBeenCalled();
      expect(p.errors).toEqual([]);

      const playback = new Playback();
      const first = playback.queue({ chunk: "c1", run: "r1", turn: "t1" }, 0.2, 0);
      playback.queue({ chunk: "c2", run: "r1", turn: "t1" }, 0.2, 0);
      expect(playback.ended(first)).toEqual([{ action: "playback.chunk.completed", chunk_id: "c1", run_id: "r1", turn_id: "t1" }]);
      expect(playback.cutSampleAccurate("r1", "t1", 75).actions).toEqual([{ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 75 }]);
    } finally {
      p.session.dispose();
    }
    expect(p.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects provider-managed delegation rather than silently treating it as client tools", async () => {
    const p = probe("provider");
    try {
      await p.session.connect({ capture: false });
      expect(p.errors.map((error) => error.message)).toEqual([expect.stringContaining("this realtime runtime supports client delegation only")]);
      expect(p.session.status).not.toBe("connected");
      expect(p.send).not.toHaveBeenCalled();
    } finally {
      p.session.dispose();
    }
  });
});
