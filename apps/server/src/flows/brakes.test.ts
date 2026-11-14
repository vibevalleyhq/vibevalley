import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { userId } from "@vibevalley/protocol";

import { type Time, wallTime } from "#/infra/time.ts";
import { sqlOf } from "#/testing/sql.ts";

import { await_, type FlowWorld, farm, lab, until } from "./farm.ts";

test("two helpers calling each other stop at the hop limit, and the user's word starts them over", async () => {
  // Each call comes a cooldown after the one before, so only the hop limit holds them.
  let skew = 0;
  const clock: Time = { ...wallTime, now: () => Date.now() + skew };
  const calls = new Map<string, string>();
  const ref: { fw?: FlowWorld } = {};
  const f = farm({
    clock,
    // A helper still finishing its turn is told soon after, not a batch later.
    change: (c) => ({ ...c, chat: { ...c.chat, noticeBatchMs: 50 } }),
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const fw = ref.fw!;
        const vibevalley = turn.options.mcpServers?.find((s) => s.name === "vibevalley");
        const token = vibevalley && "headers" in vibevalley ? (vibevalley.headers?.["authorization"] ?? "").replace("Bearer ", "") : "";
        const me = fw.session.who(token);
        const peer = calls.get(me);
        if (peer && [turn.input, ...turn.steered].some((input) => input.includes("乒乓"))) {
          skew += 61_000;
          await fw.channel.speak({ from: me, text: `@${peer} 乒乓`, target: "#general", confirm: true, anyway: true });
        }
        turn.say("好");
      },
    }),
  });
  await using fw = await f.open();
  ref.fw = fw;
  // Two profiles, each in a talk with the user (no issue holds their inputs back).
  await fw.agent.save(lab());
  await fw.agent.save({ ...lab(), id: "lab2", name: "第二位" });
  for (const profile of ["lab", "lab2"]) await fw.channel.say({ text: "你好", channel: await fw.watch.direct(profile), sendKey: "" });
  const [first, second] = await await_(
    () => fw.session.hired(),
    (hired) => hired.length === 2,
    "both talks",
  );
  calls.set(first!.id, second!.id);
  calls.set(second!.id, first!.id);
  const general = fw.channel.defaultChannel();
  const sql = sqlOf(fw.db);
  const said = async () => (await fw.channel.history(general, undefined, 200)).filter((m) => m.from === first!.id || m.from === second!.id);
  const hopNotices = async () => (await fw.channel.history(general, undefined, 200)).filter((m) => m.kind === "notice" && m.text.includes("来回"));
  const held = async () =>
    (await sql.unsafe(`select session_id, held_by from session_delivery where channel_id = $1 and held_by is not null order by position`, [general])).map(
      (r) => [r["session_id"], r["held_by"]],
    );

  await fw.channel.say({ text: `@${first!.id} 乒乓`, channel: general, sendKey: "" });
  // Four wakes by the helpers' words, then the fifth call is held and the farm says so once.
  await until(async () => (await hopNotices()).length === 1, "the hop limit's notice");
  await until(async () => (await said()).length === 5, "five calls");
  // The fifth call is the first helper's: the second is not woken by it.
  expect(await held()).toEqual([[second!.id, "hop_limit"]]);
  expect(fw.inside.deliveriesOf(second!.id).filter((row) => row.held_by === "hop_limit")).toHaveLength(1);

  // The user speaks there: the count starts over, and they call each other up to the limit again.
  await fw.channel.say({ text: `@${first!.id} 乒乓`, channel: general, sendKey: "" });
  await until(async () => (await hopNotices()).length === 2, "the hop limit's notice again");
  await until(async () => (await said()).length === 10, "five calls more");
  expect((await held()).map(([, by]) => by)).toEqual(["hop_limit", "hop_limit"]);
  expect((await fw.channel.history(general, undefined, 200)).filter((m) => m.from === userId)).toHaveLength(2);
});
