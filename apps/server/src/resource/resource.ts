import { Context, Effect, Layer, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Channel } from "#/channel/channel.ts";
import { type ApiError } from "#/errors.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import type { ProjectError } from "#/project/workplace.ts";
import { Session } from "#/session/session.ts";

import { resourceWords } from "./prompts.ts";

interface ReadResource {
  readonly uri: string;
  readonly offset?: number;
  readonly limit?: number;
}

interface ResourcePage {
  readonly uri: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
  readonly text: string;
}

export class ResourceError extends Schema.TaggedError<ResourceError, { readonly brand: unique symbol }>()("ResourceError", { message: Schema.String }) {}
const refuse = (message: string) => Effect.fail(new ResourceError({ message }));

export class Resource extends Context.Service<
  Resource,
  {
    readonly read: (session: string, input: ReadResource) => Effect.Effect<ResourcePage, ResourceError | ApiError | ProjectError>;
  }
>()("vibevalley/Resource") {
  static readonly layer = Layer.effect(
    Resource,
    Effect.suspend(() => make),
  );
}

type ResourceRef =
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "envelope"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string }
  | { readonly kind: "channel"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "github"; readonly project: string; readonly pull: number; readonly resource: "checks" | "thread"; readonly id?: string };

const defaultLimit = 4000;
const maxLimit = 16_000;
const cacheBytes = 16 * 1024 * 1024;

interface Entry {
  readonly text: string;
  readonly bytes: number;
}

/** A bounded LRU of serialized resource snapshots. Pagination slices one stable string until offset 0 refreshes it. */
export class TextCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  put(key: string, text: string): boolean {
    const bytes = new TextEncoder().encode(text).byteLength;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    if (bytes > this.maxBytes) return false;
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    this.entries.set(key, { text, bytes });
    this.bytes += bytes;
    return true;
  }
}

export const ResourceRequest = Schema.Struct({
  uri: Schema.String.annotate({ description: resourceWords.uri }),
  offset: Schema.optionalKey(Schema.Int.annotate({ description: resourceWords.offset })),
  limit: Schema.optionalKey(Schema.Int.annotate({ description: resourceWords.limit })),
}) satisfies Schema.Codec<ReadResource>;

function resourceRef(uri: string): ResourceRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "vv:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return undefined;
  let path: string[];
  try {
    path = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  switch (parsed.hostname) {
    case "trigger":
      return path.length === 1 ? { kind: "trigger", id: path[0]! } : undefined;
    case "envelope":
      return path.length === 1 ? { kind: "envelope", id: path[0]! } : undefined;
    case "issue":
      return path.length === 1 ? { kind: "issue", id: path[0]! } : undefined;
    case "channel":
      return path.length === 2 && path[1] === "messages" ? { kind: "channel", id: path[0]! } : undefined;
    case "session":
      return path.length === 2 && path[1] === "trajectory" ? { kind: "session", id: path[0]! } : undefined;
    case "github": {
      if (path.length < 4 || path[1] !== "pulls") return undefined;
      const pull = Number(path[2]);
      if (!Number.isSafeInteger(pull) || pull <= 0) return undefined;
      if (path[3] === "checks" && path.length === 4) return { kind: "github", project: path[0]!, pull, resource: "checks" };
      if (path[3] === "thread" && path.length === 5) return { kind: "github", project: path[0]!, pull, resource: "thread", id: path[4]! };
      return undefined;
    }
    default:
      return undefined;
  }
}

const textOf = (value: unknown) => JSON.stringify(value, null, 2);

const make = Effect.gen(function* () {
  const channels = yield* Channel;
  const issues = yield* Issue;
  const sessions = yield* Session;
  const ingress = yield* Ingress;
  const mailbox = yield* Mailbox;
  const cache = new TextCache(cacheBytes);

  const ownSession = (id: string) => sessions.sessionOf(id);

  const mayReadChannel = Effect.fnUntraced(function* (session: T.Session, channel: string) {
    if (session.channel === channel) return true;
    return (yield* channels.threadOfSession(session.id)) === channel;
  });

  const mayReadIssue = Effect.fnUntraced(function* (session: T.Session, target: T.Issue) {
    if (session.issue === target.id) return true;
    if (session.issue === undefined) return false;
    const own = yield* issues.get(session.issue);
    if (target.id === own.parent) return true;
    const all = new Map<string, T.Issue>((yield* issues.list()).map((item) => [item.id, item]));
    const upstream = new Set<string>();
    const visit = (id: string) => {
      if (upstream.has(id)) return;
      upstream.add(id);
      for (const need of all.get(id)?.blockedBy ?? []) visit(need);
    };
    for (const need of own.blockedBy) visit(need);
    return upstream.has(target.id);
  });

  const load = Effect.fnUntraced(function* (ref: ResourceRef, session: T.Session | undefined, orchestrator: boolean, uri: string) {
    switch (ref.kind) {
      case "trigger": {
        const resource = yield* ingress.read(ref.id).pipe(Effect.mapError((error) => new ResourceError({ message: error.message })));
        if (!resource) return yield* refuse(resourceWords.missing(uri));
        let permitted = orchestrator;
        if (session?.issue && !permitted) permitted = (yield* issues.get(session.issue)).mandate.originTriggerId === ref.id;
        if (session && !permitted) {
          const owner = yield* mailbox.ownerOf(ref.id);
          if (owner) permitted = yield* mayReadIssue(session, yield* issues.get(owner));
        }
        if (session && !permitted) {
          for (const thread of resource.trigger.threads) {
            if (thread.startsWith("issue:")) {
              const issue = yield* Effect.option(issues.get(thread.slice(6)));
              if (issue._tag === "Some" && (yield* mayReadIssue(session, issue.value))) {
                permitted = true;
                break;
              }
            } else if (thread.startsWith("channel:") && (yield* mayReadChannel(session, thread.slice(8)))) {
              permitted = true;
              break;
            }
          }
        }
        if (!permitted) return yield* refuse(resourceWords.forbidden(uri));
        const context =
          resource.trigger.source === "channel" || resource.trigger.source === "voice" || resource.trigger.source === "connector"
            ? yield* channels.envelopeResource(S.messageId(ref.id))
            : undefined;
        return textOf({ ...resource, ...(context ? { around: context.around, ...(context.parent ? { parent: context.parent } : {}) } : {}) });
      }
      case "envelope": {
        const resource = yield* channels.envelopeResource(S.messageId(ref.id));
        if (resource === undefined) return yield* refuse(resourceWords.missing(uri));
        if (!orchestrator && (session === undefined || !(yield* mayReadChannel(session, resource.message.channel))))
          return yield* refuse(resourceWords.forbidden(uri));
        return textOf(resource);
      }
      case "issue": {
        const issue = yield* issues.get(ref.id);
        if (!orchestrator && (session === undefined || !(yield* mayReadIssue(session, issue)))) return yield* refuse(resourceWords.forbidden(uri));
        return textOf({ issue, runs: yield* sessions.issueRuns(issue.id), messages: yield* channels.issueMessages(issue.id) });
      }
      case "channel": {
        if (!orchestrator && (session === undefined || !(yield* mayReadChannel(session, ref.id)))) return yield* refuse(resourceWords.forbidden(uri));
        const messages = yield* channels.history(ref.id, undefined, 200);
        return textOf({ messages, latestPage: messages.length === 200 });
      }
      case "session": {
        if (!orchestrator && session?.id !== ref.id) return yield* refuse(resourceWords.forbidden(uri));
        const events = yield* sessions.events(ref.id);
        if (events === undefined) return yield* refuse(resourceWords.missing(uri));
        return textOf({ events });
      }
      case "github": {
        const issue = (yield* issues.list()).find((item) => item.project === ref.project && item.pullRequest?.number === ref.pull);
        if (!issue) return yield* refuse(resourceWords.missing(uri));
        if (!orchestrator && (session === undefined || !(yield* mayReadIssue(session, issue)))) return yield* refuse(resourceWords.forbidden(uri));
        const snapshot = yield* ingress.githubSnapshot(ref.project, ref.pull);
        if (ref.resource === "checks") return textOf({ head: snapshot.head, checks: snapshot.checks });
        const review = snapshot.reviews.find((item) => item.id === ref.id);
        const comment = snapshot.comments.find((item) => item.id === ref.id || item.databaseId === ref.id || item.threadId === ref.id);
        if (!review && !comment) return yield* refuse(resourceWords.missing(uri));
        if (review) return textOf({ review, comments: snapshot.comments.filter((item) => item.reviewId === review.id) });
        return textOf(
          comment?.threadId
            ? { threadId: comment.threadId, resolved: comment.resolved, comments: snapshot.comments.filter((item) => item.threadId === comment.threadId) }
            : comment,
        );
      }
    }
  });

  return Resource.of({
    read: Effect.fn("Resource.read")(function* (sessionId, input) {
      const ref = resourceRef(input.uri);
      if (ref === undefined) return yield* refuse(resourceWords.invalidUri(input.uri));
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return yield* refuse(resourceWords.badOffset);
      const session = ownSession(sessionId);
      if (!session) return yield* refuse(resourceWords.forbidden(input.uri));
      const key = `${session.id}:${input.uri}`;
      let text: string;
      if (offset === 0) {
        text = yield* load(ref, session, session.role === "orchestrator", input.uri);
        if (!cache.put(key, text)) return yield* refuse(resourceWords.snapshotTooLarge);
      } else {
        const snapshot = cache.get(key);
        if (snapshot === undefined) return yield* refuse(resourceWords.snapshotMissing);
        text = snapshot;
      }
      const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), maxLimit);
      const end = Math.min(offset + limit, text.length);
      return {
        uri: input.uri,
        offset,
        totalChars: text.length,
        ...(end < text.length ? { nextOffset: end } : {}),
        text: text.slice(offset, end),
      };
    }),
  });
});
