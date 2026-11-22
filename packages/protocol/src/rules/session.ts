import type { Session, SessionView } from "../shapes";

type AnySession = Pick<Session | SessionView, "controller" | "role" | "profile" | "cwd" | "policy" | "bindings">;

export const sessionIssueId = (s: Pick<AnySession, "bindings">) => s.bindings.find((b) => b.kind === "issue")?.id;

export const sessionChannelId = (s: Pick<AnySession, "bindings">) => s.bindings.find((b) => b.kind === "channel")?.id;

export const sessionRepo = (s: Pick<AnySession, "policy">): string | undefined => {
  switch (s.policy.kind) {
    case "directCwd":
    case "managedWorktree":
      return s.policy.repo;
    case "sandboxDir":
      return undefined;
  }
};

export const sessionBranch = (s: Pick<AnySession, "policy">): string | undefined => {
  switch (s.policy.kind) {
    case "managedWorktree":
      return s.policy.branch;
    case "directCwd":
    case "sandboxDir":
      return undefined;
  }
};

export const sessionWorktree = (s: Pick<AnySession, "cwd" | "policy">): string | undefined => (s.policy.kind === "managedWorktree" ? s.cwd : undefined);

export const sessionProfile = (s: Pick<AnySession, "profile">): string | undefined => s.profile;

export const isOrchestratorSession = (s: Pick<AnySession, "controller" | "role">): boolean => s.controller === "orchestrator" && s.role === "orchestrator";

export const isFreeUserSession = (s: Pick<AnySession, "controller" | "bindings">): boolean => s.controller === "user" && s.bindings.length === 0;
