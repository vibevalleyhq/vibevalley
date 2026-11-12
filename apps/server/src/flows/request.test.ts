import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import type { Connector } from "#/gateway/connector/connector.ts";
import { handlers } from "#/gateway/http/handlers.ts";
import type { Lan } from "#/gateway/lan/lan.ts";
import type { Voice } from "#/gateway/voice/voice.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";

import { farm, lab, failure } from "./farm.ts";

/** Used by none of these requests: a stand-in that throws if it is. */
const unused = (): never => {
  throw new Error("not a door these requests go through");
};

/** A door these requests never go through: any member of it throws. */
const door: object = new Proxy({}, { get: () => unused });

/** The farm's own services and its endpoints over them; the doors these requests never go through as stand-ins that
 * fail if they are used. */
async function withDoors(f: ReturnType<typeof farm>) {
  const fw = await f.open();
  // Nothing of them is read but by mistake: every member is unused.
  const doors = { orchestrator: door as Orchestrator, lan: door as Lan, voice: door as Voice, connector: door as Connector };
  const h = handlers({ ...fw, ...doors });
  return Object.assign(fw, { h });
}

describe("a request the page may send again", () => {
  test("with the same key creates, moves, opens a thread and remembers once", async () => {
    const f = farm();
    await using fw = await withDoors(f);
    const h = fw.h;
    await fw.agent.save(lab());
    const before = (await h["issue.list"]({})).length;
    const made = await h["issue.create"]({ title: "只写一次", requestKey: "create-1" });
    const again = await h["issue.create"]({ title: "只写一次", requestKey: "create-1" });
    expect(again).toEqual(made);
    expect((await h["issue.list"]({})).length).toBe(before + 1);

    // Without the key a second cancel is refused (the issue is closed); with it, the first answer comes back.
    const moved = await h["issue.status.update"]({ id: made.id, status: "canceled", requestKey: "move-1" });
    expect(moved.status).toBe("canceled");
    const statusUpdate = await h["issue.status.update"]({ id: made.id, status: "canceled", requestKey: "move-1" });
    expect(statusUpdate).toEqual(moved);
    const statusUpdateFailure = await failure(h["issue.status.update"]({ id: made.id, status: "canceled" }));
    expect(statusUpdateFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.IssueRefused });

    const said = (await fw.channel.post({ _tag: "User", text: "开个串", sendKey: "" })).message;
    const thread = await h["channel.thread.create"]({ id: said.id, requestKey: "thread-1" });
    const threadCreate = await h["channel.thread.create"]({ id: said.id, requestKey: "thread-1" });
    expect(threadCreate).toBe(thread);

    const kept = await h["memory.create"]({ agent: "lab", text: "打卡页用中文", requestKey: "memory-1" });
    const memoryCreate = await h["memory.create"]({ agent: "lab", text: "打卡页用中文", requestKey: "memory-1" });
    expect(memoryCreate).toEqual(kept);
    expect((await h["memory.list"]({ agent: "lab" })).memories.filter((m) => m.text === "打卡页用中文")).toHaveLength(1);
  });

  test("answers with a seq that the first frame at least that far shows", async () => {
    const f = farm();
    await using fw = await withDoors(f);
    const h = fw.h;
    const core = fw.core;
    const reading = new AbortController();
    const frames = core.states(reading.signal)[Symbol.asyncIterator]();
    const take = async () => {
      const r = await frames.next();
      if (r.done === true) throw new Error("the frames ended");
      return r.value;
    };
    const made = await h["issue.create"]({ title: "看帧" });
    const moved = await h["issue.status.update"]({ id: made.id, status: "canceled" });
    expect(moved.seq).toBeGreaterThan(made.seq);
    let frame: T.StateFrame = await take();
    while (frame.seq < moved.seq) frame = await take();
    reading.abort();
    expect(frame.state.issues.find((i) => i.id === made.id)?.status).toBe("canceled");
  });

  test("set twice is one change", async () => {
    const f = farm();
    await using fw = await withDoors(f);
    const h = fw.h;
    const said = (await fw.channel.post({ _tag: "User", text: "点个赞", sendKey: "" })).message;
    const liked = await h["channel.reaction.set"]({ id: said.id, emoji: "👍", on: true });
    const again = await h["channel.reaction.set"]({ id: said.id, emoji: "👍", on: true });
    expect([again.reactions, again.revision]).toEqual([liked.reactions, liked.revision]);
    const pinned = await h["channel.pin.set"]({ id: said.id, on: true });
    expect((await h["channel.pin.set"]({ id: said.id, on: true })).revision).toBe(pinned.revision);
    const channel = await h["channel.create"]({ name: "收起来" });
    await h["channel.archive.set"]({ id: channel, on: true });
    const archived = (await h["channel.list"]()).find((c) => c.id === channel)?.archived;
    expect(archived).toBeDefined();
    await h["channel.archive.set"]({ id: channel, on: true });
    expect((await h["channel.list"]()).find((c) => c.id === channel)?.archived).toBe(archived);
  });
});
