import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Exit, Fiber, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { homeOf, savedLocale } from "@vibevalley/home";
import { setLocale } from "@vibevalley/i18n";

import { messageOf } from "./errors.ts";

// The conversation speaks the farm's language: set before the chat loads, as it says its words as it loads.
setLocale(savedLocale(homeOf()));

const { ownChat, runtimeChat } = await import("./chat/chat.ts");

const text = (name: string) => Flag.String(name).pipe(Flag.optional);
const given = (o: Option.Option<string>) => Option.getOrUndefined(o);
const prompt = text("prompt").pipe(Flag.withAlias("p"));

/** A conversation takes Ctrl+C itself (stop the turn, again to quit), so the signal that would end the program must not. What went wrong is said on stderr. */
const talk = <E>(conversation: Effect.Effect<void, E>) =>
  // oxlint-disable-next-line vibevalley/scoped-fibers -- a terminal conversation the process signal must not cut; joined at once
  Effect.uninterruptible(Effect.flatMap(Effect.forkDetach(conversation), Fiber.join)).pipe(Effect.mapError((e) => (typeof e === "string" ? e : messageOf(e))));

const runtime = Command.make(
  "runtime",
  { id: Argument.String("runtime"), model: text("model"), effort: text("effort"), resume: text("resume"), cwd: text("cwd"), prompt },
  (o) => {
    const fields = { model: given(o.model), effort: given(o.effort), resume: given(o.resume), cwd: given(o.cwd), p: given(o.prompt) };
    return talk(
      runtimeChat(o.id, {
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.effort ? { effort: fields.effort } : {}),
        ...(fields.resume ? { resume: fields.resume } : {}),
        ...(fields.cwd ? { cwd: fields.cwd } : {}),
        ...(fields.p ? { p: fields.p } : {}),
      }),
    );
  },
);

const chat = Command.make("chat", { cwd: text("cwd"), name: text("name"), model: text("model"), mcp: text("mcp"), prompt }, (o) => {
  const p = given(o.prompt);
  return talk(ownChat({ cwd: given(o.cwd) ?? "", name: given(o.name) ?? "vibevalley", model: given(o.model) ?? "", mcp: given(o.mcp) ?? "", ...(p ? { p } : {}) }));
}).pipe(Command.withSubcommands([runtime]));

Command.runWith(chat, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapError((why) => Effect.sync(() => process.stderr.write(`${typeof why === "string" ? why : messageOf(why)}\n`))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true, teardown: (end) => process.exit(Exit.isSuccess(end) ? 0 : 1) }),
);
