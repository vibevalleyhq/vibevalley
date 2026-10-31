import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Agent } from "@/agent/agent.ts";
import { Channel } from "@/channel/chat.ts";
import { channelOf } from "@/channel/folded.ts";
import { Core } from "@/core/core.ts";
import { Issue } from "@/issue/issue.ts";
import { Session } from "@/session/session.ts";
import { Said } from "@/testing/said.ts";

import { farm, lab, until } from "./farm.ts";

describe("a talk with a helper profile", () => {
  // The owner's direct channel with a profile is its hidden talk issue's thread: a word sends a session there, it answers
  // in the channel and goes home when nothing more is said; the next word sends another, told the talk so far.
  it.live("sends a session for the owner's words and lets it go when idle", () => {
    const inputs: string[] = [];
    const f = farm({
      talkIdleMs: 300,
      repos: ["clock"],
      runtime: scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          inputs.push(turn.input);
          turn.say("在呢");
        },
      }),
    });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const channels = yield* Channel;
      const sessions = yield* Session;
      const core = yield* Core;
      const { in: saidIn } = yield* Said;
      yield* (yield* Agent).save(lab());
      const dm = yield* issues.talkWith("lab");
      expect(yield* issues.talkWith("lab")).toBe(dm);
      const channel = channelOf(core.state().chat, dm)!;
      expect([channel.type, channel.peer, channel.subjectKind]).toEqual(["direct", "profile:lab", "issue"]);
      const talk = yield* issues.get(channel.subjectId!);
      expect([talk.talk, talk.assignee, talk.deliver]).toEqual([dm, "lab", "answer"]);

      const answers = () => saidIn(dm).filter((m) => m.kind === "report").length;
      yield* channels.say("仓库里有几个包？", dm, "");
      yield* until(() => answers() === 1, "the session's answer in the talk");
      const first = (yield* issues.get(talk.id)).sessions.at(-1)!;
      expect(inputs[0]).toContain("仓库里有几个包？");
      yield* until(() => sessions.find(first) === undefined, "the idle session going home");

      yield* channels.say("那 apps 下面呢？", dm, "");
      yield* until(() => answers() === 2, "a new session's answer");
      const second = (yield* issues.get(talk.id)).sessions.at(-1)!;
      expect(second).not.toBe(first);
      expect(inputs.at(-1)).toContain("仓库里有几个包？");
      expect(inputs.at(-1)).toContain("那 apps 下面呢？");
      expect((yield* issues.list()).map((t) => t.id)).not.toContain(talk.id);
      expect((yield* issues.history()).map((h) => h.issue.id)).not.toContain(talk.id);
      expect(saidIn(channels.defaultChannel())).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
