import { Effect } from "effect";

import { ownerId } from "@vibevalley/protocol";
import type { ChannelHandlers } from "@vibevalley/protocol/api";

import { missing, lookIn, reasonOf } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Game } from "#/game/game.ts";
import { requestKeys } from "#/http/api.ts";
import { Ingress } from "#/ingress/ingress.ts";

export const channelHandlers = Effect.gen(function* () {
  const channels = yield* Channel;
  const ingress = yield* Ingress;
  const game = yield* Game;
  const threadOnce = requestKeys<string>();
  const done: ChannelHandlers = {
    "channel.message.send": (body) =>
      Effect.andThen(
        Effect.sync(() => body.station !== undefined && game.want(body.station)),
        ingress.say(body.text, { ...(body.agent ? { agent: body.agent } : {}), ...(body.repo ? { repo: body.repo } : {}) }, body.id, body.sendKey ?? "", {
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
          ...(body.attachments ? { attachments: body.attachments } : {}),
          ...(body.blocks ? { blockRefs: body.blocks } : {}),
          ...(body.to !== undefined ? { to: body.to } : {}),
        }),
      ),
    "channel.create": (body) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.repo ?? ""), (c) => c.id),
    "channel.update": ({ id, ...body }) => channels.updateChannel(id, body),
    "channel.archive.set": ({ id, on }) => channels.archive(id, on),
    "channel.delete": ({ id }) => channels.removeChannel(id),
    "channel.previewDelete": ({ id }) => channels.previewRemoveChannel(id),
    "channel.notify.set": ({ id, notify }) => channels.setNotify(id, notify),
    "channel.direct.create": ({ agent }) => channels.direct(agent),
    "channel.markUnread": ({ id, number }) => channels.markUnread(id, number),
    "channel.list": () => channels.list(),
    "channel.unread.list": () => channels.unread(ownerId),
    "channel.default.set": ({ id }) => channels.makeDefault(id),
    "channel.message.list": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": ({ id, ...body }) => channels.markRead(id, body.number).pipe(Effect.mapError((e) => missing(reasonOf(e), [lookIn.channel]))),
    "channel.message.update": ({ id, text, attachments }) => channels.edit(id, text, attachments),
    "channel.message.delete": ({ id }) => channels.remove(id),
    "channel.message.previewDelete": ({ id }) => channels.previewRemove(id),
    "channel.message.search": ({ text, channel }) => channels.search(text, channel),
    "channel.reaction.set": ({ id, emoji, on }) => channels.react(id, ownerId, emoji, on),
    "channel.pin.set": ({ id, on }) => channels.pin(id, on),
    "channel.pin.list": ({ id }) => channels.pins(id),
    "channel.thread.create": ({ id, requestKey }) => threadOnce(requestKey, channels.threadUnder(id)),
    "channel.attachment.create": (upload) => channels.attach(upload),
  };
  return done;
});
