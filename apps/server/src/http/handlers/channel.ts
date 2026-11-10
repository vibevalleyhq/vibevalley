import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import type { ChannelHandlers } from "@vibevalley/protocol/api";

import { Artifact } from "#/artifact/artifact.ts";
import { missing, lookIn, reasonOf } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Game } from "#/game/game.ts";
import { requestKeys } from "#/http/api.ts";

/** Snapshots the blocks quoted by the user so later edits or deletions remain visible on the message. */
const quoteBlocks = (artifacts: Artifact["Service"], refs: readonly T.BlockRef[] | undefined): Effect.Effect<T.QuotedBlock[]> =>
  Effect.forEach(refs ?? [], (ref) =>
    Effect.gen(function* () {
      const snapshot = yield* artifacts.blocks(ref.artifactId);
      const block = snapshot.blocks.find((b) => b.id === ref.blockId);
      return {
        artifactId: ref.artifactId,
        blockId: ref.blockId,
        rev: ref.rev,
        title: snapshot.artifact.title,
        ...(block ? { type: block.type, text: block.text.map((s) => s.t).join(""), nowRev: block.rev } : { deleted: true }),
      } satisfies T.QuotedBlock;
    }).pipe(Effect.catch((e) => Effect.as(Effect.logWarning("quoting a block failed", e), undefined))),
  ).pipe(Effect.map((all) => all.flatMap((b) => (b === undefined ? [] : [b]))));

export const channelHandlers = Effect.gen(function* () {
  const artifacts = yield* Artifact;
  const channels = yield* Channel;
  const game = yield* Game;
  const threadOnce = requestKeys<string>();
  const done: ChannelHandlers = {
    "channel.message.send": (body) =>
      Effect.gen(function* () {
        if (body.station !== undefined) game.want(body.station);
        const blocks = yield* quoteBlocks(artifacts, body.blocks);
        yield* channels.say(body.text, { ...(body.agent ? { agent: body.agent } : {}), ...(body.repo ? { repo: body.repo } : {}) }, body.id, body.sendKey ?? "", {
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
          ...(body.attachments ? { attachments: body.attachments } : {}),
          ...(blocks.length > 0 ? { blocks } : {}),
          ...(body.to !== undefined ? { to: body.to } : {}),
        });
      }),
    "channel.create": (body) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.repo ?? ""), (c) => c.id),
    "channel.update": ({ id, ...body }) => channels.updateChannel(id, body),
    "channel.archive.set": ({ id, on }) => channels.archive(id, on),
    "channel.delete": ({ id }) => channels.removeChannel(id),
    "channel.previewDelete": ({ id }) => channels.previewRemoveChannel(id),
    "channel.notify.set": ({ id, notify }) => channels.setNotify(id, notify),
    "channel.direct.create": ({ agent }) => channels.direct(agent),
    "channel.markUnread": ({ id, number }) => channels.markUnread(id, number),
    "channel.list": () => channels.list(),
    "channel.unread.list": () => channels.unread(userId),
    "channel.default.set": ({ id }) => channels.makeDefault(id),
    "channel.message.list": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": ({ id, ...body }) => channels.markRead(id, body.number).pipe(Effect.mapError((e) => missing(reasonOf(e), [lookIn.channel]))),
    "channel.message.update": ({ id, text, attachments }) => channels.edit(id, text, attachments),
    "channel.message.delete": ({ id }) => channels.remove(id),
    "channel.message.previewDelete": ({ id }) => channels.previewRemove(id),
    "channel.message.search": ({ text, channel }) => channels.search(text, channel),
    "channel.reaction.set": ({ id, emoji, on }) => channels.react(id, userId, emoji, on),
    "channel.pin.set": ({ id, on }) => channels.pin(id, on),
    "channel.pin.list": ({ id }) => channels.pins(id),
    "channel.thread.create": ({ id, requestKey }) => threadOnce(requestKey, channels.threadUnder(id)),
  };
  return done;
});
