import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import { isApiError } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { messageOf } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";

import { resourceWords } from "./prompts.ts";
import { callerOf, customTool, type Who } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export interface ReadResource {
  readonly uri: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ResourcePage {
  readonly uri: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
  readonly text: string;
}

/** A resource read refused: a bad URI or offset, one this session may not read, or a snapshot gone. */
class ResourceError extends Error {
  override readonly name = "ResourceError";
}
const refuse = (message: string) => new ResourceError(message);

type ResourceRef =
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "envelope"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string }
  | { readonly kind: "channel"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "github"; readonly repo: string; readonly pull: number; readonly resource: "checks" | "thread"; readonly id?: string };

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

const ResourceRequest = z.object({
  uri: z.string().describe(resourceWords.uri),
  offset: z.exactOptional(z.number().int().describe(resourceWords.offset)),
  limit: z.exactOptional(z.number().int().describe(resourceWords.limit)),
}) satisfies z.ZodType<ReadResource>;

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
  const [first, second, third, fourth, fifth] = path;
  switch (parsed.hostname) {
    case "trigger":
      return path.length === 1 && first ? { kind: "trigger", id: first } : undefined;
    case "envelope":
      return path.length === 1 && first ? { kind: "envelope", id: first } : undefined;
    case "issue":
      return path.length === 1 && first ? { kind: "issue", id: first } : undefined;
    case "channel":
      return path.length === 2 && first && second === "messages" ? { kind: "channel", id: first } : undefined;
    case "session":
      return path.length === 2 && first && second === "trajectory" ? { kind: "session", id: first } : undefined;
    case "github": {
      if (!first || path.length < 4 || second !== "pulls") return undefined;
      const pull = Number(third);
      if (!Number.isSafeInteger(pull) || pull <= 0) return undefined;
      if (fourth === "checks" && path.length === 4) return { kind: "github", repo: first, pull, resource: "checks" };
      if (fourth === "thread" && path.length === 5 && fifth) return { kind: "github", repo: first, pull, resource: "thread", id: fifth };
      return undefined;
    }
    default:
      return undefined;
  }
}

const textOf = (value: unknown): string => JSON.stringify(value, null, 2);

export function makeResourceReader(deps: Pick<ToolDeps, "channel" | "issue" | "session" | "repo">) {
  const { channel: channels, issue: issues, session: sessions, repo: repos } = deps;
  const cache = new TextCache(cacheBytes);

  const ownSession = (id: string) => sessions.live(id).session;

  const mayReadChannel = async (session: T.Session, channel: string) => {
    if (session.channel === channel) return true;
    return (await channels.threadOfSession(session.id)) === channel;
  };

  const mayReadIssue = async (session: T.Session, target: T.Issue) => {
    if (session.issue === target.id) return true;
    if (session.issue === undefined) return false;
    const own = await issues.get(session.issue);
    if (target.id === own.parent) return true;
    const all = new Map<string, T.Issue>((await issues.list()).map((item) => [item.id, item]));
    const upstream = new Set<string>();
    const visit = (id: string) => {
      if (upstream.has(id)) return;
      upstream.add(id);
      for (const need of all.get(id)?.blockedBy ?? []) visit(need);
    };
    for (const need of own.blockedBy) visit(need);
    return upstream.has(target.id);
  };

  const issueOrUndefined = async (id: string) => {
    try {
      return await issues.get(id);
    } catch (e) {
      // A thread naming an issue since removed just does not grant the read.
      if (isApiError(e)) return undefined;
      throw e;
    }
  };

  const load = async (ref: ResourceRef, session: T.Session | undefined, orchestrator: boolean, uri: string): Promise<string> => {
    switch (ref.kind) {
      case "trigger": {
        let resource;
        try {
          resource = await sessions.trigger(ref.id);
        } catch (error) {
          throw new ResourceError(messageOf(error), { cause: error });
        }
        if (!resource) throw refuse(resourceWords.missing(uri));
        let permitted = orchestrator;
        if (session?.issue && !permitted) permitted = (await issues.get(session.issue)).mandate.originTriggerId === ref.id;
        if (session && !permitted) {
          const owner = await sessions.ownerOf(ref.id);
          if (owner) {
            const ownerIssue = await issues.get(owner);
            permitted = await mayReadIssue(session, ownerIssue);
          }
        }
        if (session && !permitted) {
          for (const thread of resource.trigger.threads) {
            if (thread.startsWith("issue:")) {
              const issue = await issueOrUndefined(thread.slice(6));
              if (issue !== undefined && (await mayReadIssue(session, issue))) {
                permitted = true;
                break;
              }
            } else if (thread.startsWith("channel:") && (await mayReadChannel(session, thread.slice(8)))) {
              permitted = true;
              break;
            }
          }
        }
        if (!permitted) throw refuse(resourceWords.forbidden(uri));
        const context =
          resource.trigger.source === "channel" || resource.trigger.source === "voice" || resource.trigger.source === "connector"
            ? await channels.envelopeResource(S.messageId(ref.id))
            : undefined;
        return textOf({ ...resource, ...(context ? { around: context.around, ...(context.parent ? { parent: context.parent } : {}) } : {}) });
      }
      case "envelope": {
        const resource = await channels.envelopeResource(S.messageId(ref.id));
        if (resource === undefined) throw refuse(resourceWords.missing(uri));
        if (!orchestrator && (session === undefined || !(await mayReadChannel(session, resource.message.channel)))) throw refuse(resourceWords.forbidden(uri));
        return textOf(resource);
      }
      case "issue": {
        const issue = await issues.get(ref.id);
        if (!orchestrator && (session === undefined || !(await mayReadIssue(session, issue)))) throw refuse(resourceWords.forbidden(uri));
        return textOf({ issue, runs: await sessions.runsOf(issue.id), messages: await channels.issueMessages(issue.id) });
      }
      case "channel": {
        if (!orchestrator && (session === undefined || !(await mayReadChannel(session, ref.id)))) throw refuse(resourceWords.forbidden(uri));
        const messages = await channels.history(ref.id, undefined, 200);
        return textOf({ messages, latestPage: messages.length === 200 });
      }
      case "session": {
        if (!orchestrator && session?.id !== ref.id) throw refuse(resourceWords.forbidden(uri));
        const events = await sessions.eventsOf(ref.id);
        if (events === undefined) throw refuse(resourceWords.missing(uri));
        return textOf({ events });
      }
      case "github": {
        const issue = (await issues.list()).find((item) => item.repo === ref.repo && item.pullRequest?.number === ref.pull);
        if (!issue) throw refuse(resourceWords.missing(uri));
        if (!orchestrator && (session === undefined || !(await mayReadIssue(session, issue)))) throw refuse(resourceWords.forbidden(uri));
        const snapshot = await repos.githubSnapshot(ref.repo, ref.pull);
        if (ref.resource === "checks") return textOf({ head: snapshot.head, checks: snapshot.checks });
        const review = snapshot.reviews.find((item) => item.id === ref.id);
        const comment = snapshot.comments.find((item) => item.id === ref.id || item.databaseId === ref.id || item.threadId === ref.id);
        if (!review && !comment) throw refuse(resourceWords.missing(uri));
        if (review) return textOf({ review, comments: snapshot.comments.filter((item) => item.reviewId === review.id) });
        return textOf(
          comment?.threadId
            ? { threadId: comment.threadId, resolved: comment.resolved, comments: snapshot.comments.filter((item) => item.threadId === comment.threadId) }
            : comment,
        );
      }
    }
  };

  /** Throws ResourceError, or what the reads under it throw (ApiError, RepoError). */
  return async (sessionId: string, input: ReadResource): Promise<ResourcePage> => {
    const ref = resourceRef(input.uri);
    if (ref === undefined) throw refuse(resourceWords.invalidUri(input.uri));
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw refuse(resourceWords.badOffset);
    const session = ownSession(sessionId);
    if (!session) throw refuse(resourceWords.forbidden(input.uri));
    const key = `${session.id}:${input.uri}`;
    let text: string;
    if (offset === 0) {
      text = await load(ref, session, session.role === "orchestrator", input.uri);
      if (!cache.put(key, text)) throw refuse(resourceWords.snapshotTooLarge);
    } else {
      const snapshot = cache.get(key);
      if (snapshot === undefined) throw refuse(resourceWords.snapshotMissing);
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
  };
}

export const resourceTools = (readResource: ReturnType<typeof makeResourceReader>) => (who: Who) =>
  customTool("resource_read", resourceWords.description, ResourceRequest, async (input) => {
    const caller = callerOf(who);
    const page = await readResource(caller.session || caller.agent, input);
    return jsonText(page);
  });
