import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { ApiError, type ChannelHandlers } from "@vibevalley/protocol/api";

import { lookIn, missing, reasonOf } from "#/base/errors.ts";
import { requestKeys } from "#/gateway/http/api.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Artifact } from "#/modules/artifact/artifact.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Game } from "#/modules/game/game.ts";
import type { Watch } from "#/modules/watch/watch.ts";

/** Snapshots the blocks quoted by the user so later edits or deletions remain visible on the message. */
async function quoteBlocks(artifacts: Artifact, refs: readonly T.BlockRef[] | undefined, log: Logger): Promise<T.QuotedBlock[]> {
  const out: T.QuotedBlock[] = [];
  for (const ref of refs ?? []) {
    try {
      const snapshot = await artifacts.blocks(ref.artifactId);
      const block = snapshot.blocks.find((b) => b.id === ref.blockId);
      out.push({
        artifactId: ref.artifactId,
        blockId: ref.blockId,
        rev: ref.rev,
        title: snapshot.artifact.title,
        ...(block ? { type: block.type, text: block.text.map((s) => s.t).join(""), nowRev: block.rev } : { deleted: true }),
      } satisfies T.QuotedBlock);
    } catch (e) {
      // A block that cannot be read is left out of the quote: the message still goes.
      log.warn("quoting a block failed", e);
    }
  }
  return out;
}

export interface ChannelHandlersDeps {
  readonly agent: Agent;
  readonly artifact: Artifact;
  readonly channel: Channel;
  readonly watch: Watch;
  readonly game: Game;
  readonly clock: Time;
  readonly log: Logger;
}

export function channelHandlers(deps: ChannelHandlersDeps): ChannelHandlers {
  const { agent: agents, artifact: artifacts, channel: channels, watch, game } = deps;
  const log = deps.log.child("http/channel");
  const threadOnce = requestKeys<string>(deps.clock);
  return {
    "channel.message.send": async (body) => {
      if (body.station !== undefined) game.want(body.station);
      const blocks = await quoteBlocks(artifacts, body.blocks, log);
      // A profile picked that is not there is not passed on.
      const picked = body.agent !== undefined ? agents.agent(body.agent)?.id : undefined;
      await channels.say({
        text: body.text,
        channel: body.id,
        sendKey: body.sendKey ?? "",
        picked: { ...(picked ? { agent: picked } : {}), ...(body.repo ? { repo: body.repo } : {}) },
        ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
        ...(body.attachments ? { attachments: body.attachments } : {}),
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(body.to !== undefined ? { to: body.to } : {}),
      });
    },
    "channel.create": async (body) => (await channels.openChannel(body.name, body.description ?? "", body.repo ?? "")).id,
    "channel.update": ({ id, ...body }) => channels.updateChannel(id, body),
    "channel.archive.set": ({ id, on }) => channels.archive(id, on),
    "channel.delete": ({ id }) => channels.removeChannel(id),
    "channel.previewDelete": ({ id }) => channels.previewRemoveChannel(id),
    "channel.notify.set": ({ id, notify }) => channels.setNotify(id, notify),
    "channel.direct.create": ({ agent }) => watch.direct(agent),
    "channel.markUnread": ({ id, number }) => channels.markUnread(id, number),
    "channel.list": () => channels.list(),
    "channel.unread.list": () => channels.unread(userId),
    "channel.default.set": ({ id }) => channels.makeDefault(id),
    "channel.message.list": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": async ({ id, ...body }) => {
      try {
        await channels.markRead(id, body.number);
      } catch (e) {
        if (e instanceof ApiError) throw missing(reasonOf(e), [lookIn.channel]);
        throw e;
      }
    },
    "channel.message.update": ({ id, text, attachments }) => channels.edit(id, text, attachments),
    "channel.message.delete": ({ id }) => channels.remove(id),
    "channel.message.previewDelete": ({ id }) => deps.watch.previewRemove(id),
    "channel.message.search": ({ text, channel }) => channels.search(text, channel),
    "channel.reaction.set": ({ id, emoji, on }) => channels.react(id, userId, emoji, on),
    "channel.pin.set": ({ id, on }) => channels.pin(id, on),
    "channel.pin.list": ({ id }) => channels.pins(id),
    "channel.thread.create": ({ id, requestKey }) => threadOnce(requestKey, () => channels.threadUnder(id)),
  };
}
