import type { Session, SessionView } from "../shapes";

type AnySession = Pick<Session | SessionView, "controller" | "role" | "profile" | "cwd" | "policy" | "bindings">;

export const sessionIssueId = (s: Pick<AnySession, "bindings">) => s.bindings.find((b) => b.kind === "issue")?.id;

export const sessionChannelId = (s: Pick<AnySession, "bindings">) => s.bindings.find((b) => b.kind === "channel")?.id;

export const sessionRepo = (s: Pick<AnySession, "policy">): string | undefined => {
  switch (s.policy.kind) {
    case "directCwd":
      return s.policy.repo;
    case "sandboxDir":
      return undefined;
  }
};

export const sessionProfile = (s: Pick<AnySession, "profile">): string | undefined => s.profile;

export const isOrchestratorSession = (s: Pick<AnySession, "controller" | "role">): boolean => s.controller === "daemon" && s.role === "orchestrator";

export const isFreeUserSession = (s: Pick<AnySession, "controller" | "bindings">): boolean => s.controller === "user" && s.bindings.length === 0;
