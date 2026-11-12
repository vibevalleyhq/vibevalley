import { t } from "@vibevalley/i18n";
import { ApiError, BizCode, type BizErrorCode, type Next, type VoiceFix } from "@vibevalley/protocol/api";

export { ApiError, BizCode, type BizErrorCode, type Next };

// A hint's say is a getter read in the locale of the moment (listed below): copied here, when the error is made.
const materializeNext = (items: readonly Next[]): readonly Next[] =>
  items.map((item) => ({ say: item.say, ...(item.run !== undefined ? { run: [...item.run] } : {}) }));

/** An ApiError with a six-digit business error code, message, and optional remediation detail: thrown, never returned. */
export const bizError = (bizCode: BizErrorCode, message: string, options?: { readonly next?: readonly Next[]; readonly settings?: VoiceFix }): ApiError =>
  new ApiError(bizCode, message, {
    ...(options?.next !== undefined && options.next.length > 0 ? { next: materializeNext(options.next) } : {}),
    ...(options?.settings !== undefined ? { settings: options.settings } : {}),
  });

export const refused = (reason: string, next?: readonly Next[], bizCode: BizErrorCode = BizCode.Refused): ApiError =>
  bizError(bizCode, reason, next !== undefined ? { next } : undefined);

/** Module-scoped refusal builder bound to a specific six-digit BizCode. */
export const refuseIn =
  (bizCode: BizErrorCode) =>
  (reason: string, next?: readonly Next[]): ApiError =>
    bizError(bizCode, reason, next !== undefined ? { next } : undefined);

/** What a hint to list the ones that are names (server.lookIn in the catalog). */
type LookIn =
  | "issue"
  | "session"
  | "repo"
  | "runtime"
  | "agent"
  | "skill"
  | "template"
  | "cron"
  | "device"
  | "channel"
  | "graph"
  | "memories"
  | "artifact"
  | "library"
  | "pkm";

const missingCodeByHint = new WeakMap<Next, BizErrorCode>();

/** Something asked for by id or name is not there. next is required: where to look for the ones that are (lookIn). */
export const missing = (what: string, next: readonly Next[], bizCode?: BizErrorCode): ApiError => {
  const code = bizCode ?? (next[0] !== undefined ? missingCodeByHint.get(next[0]) : undefined) ?? BizCode.NotFound;
  return bizError(code, what, next.length > 0 ? { next } : undefined);
};

/** Where to find the ones that are there, as the command that lists them. */
// say is read when the error is made, in the locale of the moment.
const listed = (key: LookIn, code: BizErrorCode, run?: readonly string[]): Next => {
  const hint: Next = {
    get say() {
      return t(`server.lookIn.${key}`);
    },
    ...(run !== undefined ? { run: [...run] } : {}),
  };
  missingCodeByHint.set(hint, code);
  return hint;
};

export const lookIn = {
  issue: listed("issue", BizCode.IssueNotFound, ["issue", "list"]),
  session: listed("session", BizCode.SessionNotFound, ["session", "list"]),
  repo: listed("repo", BizCode.RepoNotFound, ["repo", "list"]),
  runtime: listed("runtime", BizCode.RuntimeNotFound, ["runtime", "list"]),
  agent: listed("agent", BizCode.AgentNotFound, ["agent", "list"]),
  skill: listed("skill", BizCode.AgentNotFound),
  template: listed("template", BizCode.AgentNotFound),
  cron: listed("cron", BizCode.CronNotFound, ["cron", "list"]),
  device: listed("device", BizCode.UserNotFound),
  channel: listed("channel", BizCode.ChannelNotFound, ["channel", "list"]),
  artifact: listed("artifact", BizCode.ArtifactNotFound, ["artifact", "list"]),
  library: listed("library", BizCode.LibraryNotFound, ["library", "item", "list"]),
  pkm: listed("pkm", BizCode.PkmNotFound, ["pkm", "page", "list"]),
} satisfies Record<string, Next>;

/** Where an agent's memories are listed. */
export const memoriesOf = (agent: string): Next => {
  const hint: Next = { say: t("server.lookIn.memories"), run: ["memory", "list", agent] };
  missingCodeByHint.set(hint, BizCode.MemoryNotFound);
  return hint;
};

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string => e.message;

/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A failed system call's code (ENOENT, EPERM…), or undefined for anything else. */
export const errnoOf = (e: unknown): string | undefined => (e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined);

/** A defect, never an expected failure: the farm's own records disagree with each other, or a caller broke a rule it is held to. */
export class Inconsistent extends Error {
  override readonly name = "Inconsistent";
}

/** A lookup's answer, or Missing (what was not found, and where to look) thrown when it found none. */
export const orMissing =
  (what: string, look: readonly Next[], bizCode?: BizErrorCode) =>
  <A>(found: A | undefined): A => {
    if (found === undefined) throw missing(what, look, bizCode);
    return found;
  };
