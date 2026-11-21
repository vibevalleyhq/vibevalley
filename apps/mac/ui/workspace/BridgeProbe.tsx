// A self-test of the bridge against the fake server: runs each part of the
// contract once and reports the results to the shell (debug dump "probe").
import { Text, View } from "nsh";

import { act, call, frame, frameRev, hostApi, onLive, subscribe, type Envelope } from "../infra/bridge";

type StateFrame = { seq: number; state: { issues: unknown[] } };

export function BridgeProbe() {
  const state = frame<StateFrame>("state");
  const rev = frameRev("state");
  const results: Record<string, unknown> = {};
  const live: unknown[] = [];
  const events: unknown[] = [];
  onLive((e) => live.push(e));
  const report = () => act({ type: "probe", results: { ...results, live, events, stateSeq: state()?.seq ?? null, stateRev: rev() } });
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
    await call("fake.setState", { state: { state: { issues: [{ id: "i1" }] } } });
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
        Bridge probe: state seq {state()?.seq ?? "…"}, rev {rev()}
      </Text>
    </View>
  );
}
