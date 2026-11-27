import type { Issue, Session } from "@vibevalley/protocol";

import type { Lane } from "../../model/cards";
import type { NewIssueAt } from "../NewIssue";

export type IssueOverlay =
  | { readonly kind: "none" }
  | { readonly kind: "peeking"; readonly id: string }
  | { readonly kind: "new"; readonly at: NewIssueAt }
  | {
      readonly kind: "closing";
      readonly issue: Issue;
      readonly session: Session | undefined;
      readonly review: boolean;
      readonly lane?: Lane;
      readonly returnPeekId?: string;
    }
  | { readonly kind: "reopening"; readonly issue: Issue; readonly lane: Lane };

export type IssueOverlayEvent =
  | { readonly kind: "peek"; readonly id: string }
  | { readonly kind: "openNew"; readonly at: NewIssueAt }
  | { readonly kind: "openClose"; readonly issue: Issue; readonly session: Session | undefined; readonly review: boolean; readonly lane?: Lane }
  | { readonly kind: "openReopen"; readonly issue: Issue; readonly lane: Lane }
  | { readonly kind: "dismiss" }
  | { readonly kind: "clear" };

export function initialIssueOverlay(): IssueOverlay {
  return { kind: "none" };
}

export function issueOverlayTransition(state: IssueOverlay, event: IssueOverlayEvent): IssueOverlay {
  switch (event.kind) {
    case "peek":
      return { kind: "peeking", id: event.id };
    case "openNew":
      return { kind: "new", at: event.at };
    case "openClose": {
      const returnPeekId = state.kind === "peeking" ? state.id : state.kind === "closing" ? state.returnPeekId : undefined;
      return {
        kind: "closing",
        issue: event.issue,
        session: event.session,
        review: event.review,
        ...(event.lane !== undefined ? { lane: event.lane } : {}),
        ...(returnPeekId !== undefined ? { returnPeekId } : {}),
      };
    }
    case "openReopen":
      return { kind: "reopening", issue: event.issue, lane: event.lane };
    case "dismiss":
      if (state.kind === "closing" && state.returnPeekId !== undefined) {
        return { kind: "peeking", id: state.returnPeekId };
      }
      return { kind: "none" };
    case "clear":
      return { kind: "none" };
  }
}

export function effectiveIssueOverlay(state: IssueOverlay, rest: string, routeDefaults: NewIssueAt, openId: string | undefined): IssueOverlay {
  if (rest === "new") return { kind: "new", at: routeDefaults };
  if (openId !== undefined && state.kind === "peeking") return { kind: "none" };
  return state;
}

export function isIssueOverlayBlocking(state: IssueOverlay): boolean {
  switch (state.kind) {
    case "none":
      return false;
    case "peeking":
    case "new":
    case "closing":
    case "reopening":
      return true;
  }
}
