// A self-test of the bridge against the fake server: runs each part of the
// contract once and reports the results to the shell (debug dump "probe").
import { Text, View } from "nsh";

import type { SliceBundle } from "@vibevalley/protocol";

import { act, call, frameRev, hostApi, onLive, sliceFrame, subscribe, type Envelope } from "../infra/bridge";

const probeBundle: SliceBundle = {
  seq: 2,
  board: { seq: 2, issues: [] },
  sessions: { seq: 2, sessions: [], machines: [] },
  collab: { seq: 2, connectors: [] },
  inbox: { seq: 2, items: [], call: "idle", callReason: "" },
  ops: { seq: 2, crons: [] },
  farm: { seq: 2, view: { level: { level: 1, xp: 0, need: 10 }, plots: {}, plays: {} }, effects: [] },
};

export function BridgeProbe() {
  const board = sliceFrame("board");
  const rev = frameRev("slice:board");
  const results: Record<string, unknown> = {};
  const live: unknown[] = [];
  const events: unknown[] = [];
  onLive((e) => live.push(e));
  const report = () => act({ type: "probe", results: { ...results, live, events, stateSeq: board()?.seq ?? null, stateRev: rev() } });
  void (async () => {
    results.health = await call("health");
    results.missing = (await call("issue.nope", { id: 1 })).bizCode;
    results.info = (await hostApi.info()).data;
    const stop = subscribe(
      "channel.follow",
      { id: "c1", after: 0 },
      (e) => events.push(e),
      (why) => (results.ended = why),
    );
    const refused = await new Promise<Envelope | null>((resolve) => subscribe("fake.refuse", {}, () => {}, resolve));
    results.refused = refused?.bizCode ?? null;
    await call("fake.emit", { name: "channel.follow", event: { n: 1 } });
    await call("fake.live", { event: { type: "notice", at: 1, level: "info", text: "probe" } });
    await call("fake.setState", { state: probeBundle });
    await call("fake.end", { name: "channel.follow" });
    stop();
    results.terminal = await hostApi.openTerminal({ cwd: "/tmp", command: "echo PROBE_TERMINAL_$((40+2))" });
    results.tray = (await hostApi.tray({ title: "2 need you", lines: ["a", "b"] })).bizCode;
    results.badTheme = (await call("host.theme", "purple")).bizCode;
    setTimeout(report, 1500);
  })();
  return (
    <View class="flex-1 bg-side p-4">
      <Text class="text-sm text-ink">
        Bridge probe: board seq {board()?.seq ?? "…"}, rev {rev()}
      </Text>
    </View>
  );
}
