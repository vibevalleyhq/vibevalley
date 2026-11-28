import type { Changes, DeliveryReceipt } from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

export type DeliveryReceiptKind = "none" | DeliveryReceipt["kind"];

export interface DeliveryReceiptDraft {
  readonly kind: DeliveryReceiptKind;
  readonly url: string;
  readonly number: string;
  readonly sha: string;
  readonly branch: string;
  readonly noteId: string;
  readonly title: string;
  readonly summary: string;
}

export type DeliveryReceiptMissingField = "url" | "sha" | "noteId" | "summary";

export type BuiltDeliveryReceipt =
  | { readonly ok: true; readonly receipt?: DeliveryReceipt }
  | { readonly ok: false; readonly missing: DeliveryReceiptMissingField };

export function initialReceiptDraft(existing?: DeliveryReceipt): DeliveryReceiptDraft {
  const empty: DeliveryReceiptDraft = {
    kind: "none",
    url: "",
    number: "",
    sha: "",
    branch: "",
    noteId: "",
    title: "",
    summary: "",
  };
  if (!existing) return empty;
  switch (existing.kind) {
    case "pull_request":
      return {
        ...empty,
        kind: "pull_request",
        url: existing.url,
        number: existing.number !== undefined ? String(existing.number) : "",
        branch: existing.branch ?? "",
        summary: existing.summary ?? "",
      };
    case "commit":
      return {
        ...empty,
        kind: "commit",
        sha: existing.sha,
        branch: existing.branch ?? "",
        summary: existing.summary ?? "",
      };
    case "note":
      return {
        ...empty,
        kind: "note",
        noteId: existing.noteId,
        title: existing.title ?? "",
        summary: existing.summary ?? "",
      };
    case "answer":
      return {
        ...empty,
        kind: "answer",
        summary: existing.summary,
      };
  }
}

export function buildDeliveryReceipt(draft: DeliveryReceiptDraft): BuiltDeliveryReceipt {
  const trim = (value: string) => value.trim();
  switch (draft.kind) {
    case "none":
      return { ok: true };
    case "pull_request": {
      const url = trim(draft.url);
      if (!url) return { ok: false, missing: "url" };
      const rawNum = trim(draft.number);
      const parsedNum = rawNum !== "" ? Number(rawNum) : Number.NaN;
      const num = Number.isInteger(parsedNum) && parsedNum > 0 ? parsedNum : undefined;
      const branch = trim(draft.branch) || undefined;
      const summary = trim(draft.summary) || undefined;
      return {
        ok: true,
        receipt: {
          kind: "pull_request",
          url,
          ...(num !== undefined ? { number: num } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(summary !== undefined ? { summary } : {}),
        },
      };
    }
    case "commit": {
      const sha = trim(draft.sha);
      if (!sha) return { ok: false, missing: "sha" };
      const branch = trim(draft.branch) || undefined;
      const summary = trim(draft.summary) || undefined;
      return {
        ok: true,
        receipt: {
          kind: "commit",
          sha,
          ...(branch !== undefined ? { branch } : {}),
          ...(summary !== undefined ? { summary } : {}),
        },
      };
    }
    case "note": {
      const id = trim(draft.noteId);
      if (!id) return { ok: false, missing: "noteId" };
      const title = trim(draft.title) || undefined;
      const summary = trim(draft.summary) || undefined;
      return {
        ok: true,
        receipt: {
          kind: "note",
          noteId: noteId(id),
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {}),
        },
      };
    }
    case "answer": {
      const summary = trim(draft.summary);
      if (!summary) return { ok: false, missing: "summary" };
      return { ok: true, receipt: { kind: "answer", summary } };
    }
  }
}

export type CloseOperation =
  | { readonly kind: "cancel" }
  | { readonly kind: "complete"; readonly changes: Changes; readonly sinceTree: string | undefined }
  | { readonly kind: "resolve"; readonly changes: Changes; readonly sinceTree: string | undefined };

export type CloseFlowState =
  | { readonly kind: "confirming" }
  | { readonly kind: "loadingDiff"; readonly sinceTree: string | undefined; readonly notice: string }
  | { readonly kind: "loadFailed"; readonly sinceTree: string | undefined; readonly message: string }
  | { readonly kind: "reviewing"; readonly changes: Changes; readonly sinceTree: string | undefined; readonly notice: string }
  | { readonly kind: "submitting"; readonly operation: CloseOperation }
  | { readonly kind: "treeChanged"; readonly sinceTree: string | undefined; readonly message: string; readonly refetch: boolean }
  | { readonly kind: "done" };

export type CloseFlowEvent =
  | { readonly kind: "openReview" }
  | { readonly kind: "diffLoaded"; readonly changes: Changes }
  | { readonly kind: "diffFailed"; readonly message: string }
  | { readonly kind: "submitCancel" }
  | { readonly kind: "submitComplete" }
  | { readonly kind: "submitResolve" }
  | { readonly kind: "submitFailed"; readonly message?: string }
  | { readonly kind: "reviewRejected"; readonly message: string; readonly bizCode?: number }
  | { readonly kind: "completed" }
  | { readonly kind: "dismiss" };

export type CloseDialogSurface =
  | { readonly kind: "confirm"; readonly busy: boolean }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "review"; readonly changes: Changes; readonly notice: string; readonly busy: boolean }
  | { readonly kind: "done" };

export function initialCloseFlow(review: boolean): CloseFlowState {
  return review ? { kind: "loadingDiff", sinceTree: undefined, notice: "" } : { kind: "confirming" };
}

export function closeFlowTransition(state: CloseFlowState, event: CloseFlowEvent): CloseFlowState {
  switch (state.kind) {
    case "confirming":
      switch (event.kind) {
        case "openReview":
          return { kind: "loadingDiff", sinceTree: undefined, notice: "" };
        case "submitCancel":
          return { kind: "submitting", operation: { kind: "cancel" } };
        case "dismiss":
          return { kind: "done" };
        case "diffLoaded":
        case "diffFailed":
        case "submitComplete":
        case "submitResolve":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
          return state;
      }
      break;

    case "loadingDiff":
      switch (event.kind) {
        case "diffLoaded":
          return { kind: "reviewing", changes: event.changes, sinceTree: state.sinceTree, notice: state.notice };
        case "diffFailed":
          return { kind: "loadFailed", sinceTree: state.sinceTree, message: event.message };
        case "dismiss":
          return { kind: "done" };
        case "openReview":
        case "submitCancel":
        case "submitComplete":
        case "submitResolve":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
          return state;
      }
      break;

    case "loadFailed":
      switch (event.kind) {
        case "diffLoaded":
          return { kind: "reviewing", changes: event.changes, sinceTree: state.sinceTree, notice: "" };
        case "diffFailed":
          return event.message === state.message ? state : { kind: "loadFailed", sinceTree: state.sinceTree, message: event.message };
        case "dismiss":
          return { kind: "done" };
        case "openReview":
        case "submitCancel":
        case "submitComplete":
        case "submitResolve":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
          return state;
      }
      break;

    case "reviewing":
      switch (event.kind) {
        case "diffLoaded":
          return event.changes === state.changes ? state : { kind: "reviewing", changes: event.changes, sinceTree: state.sinceTree, notice: state.notice };
        case "diffFailed":
          return { kind: "loadFailed", sinceTree: state.sinceTree, message: event.message };
        case "submitComplete":
          return { kind: "submitting", operation: { kind: "complete", changes: state.changes, sinceTree: state.sinceTree } };
        case "submitResolve":
          return { kind: "submitting", operation: { kind: "resolve", changes: state.changes, sinceTree: state.sinceTree } };
        case "dismiss":
          return { kind: "done" };
        case "openReview":
        case "submitCancel":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
          return state;
      }
      break;

    case "submitting":
      switch (event.kind) {
        case "completed":
        case "dismiss":
          return { kind: "done" };
        case "reviewRejected":
          switch (state.operation.kind) {
            case "cancel":
              return { kind: "confirming" };
            case "complete": {
              // When the worktree moved past the shown revision, request an incremental diff since its tree.
              const shownTree = state.operation.changes.revision?.tree;
              if (shownTree !== undefined && shownTree !== state.operation.sinceTree) {
                return { kind: "treeChanged", sinceTree: shownTree, message: event.message, refetch: false };
              }
              return { kind: "treeChanged", sinceTree: state.operation.sinceTree, message: event.message, refetch: true };
            }
            case "resolve":
              return { kind: "reviewing", changes: state.operation.changes, sinceTree: state.operation.sinceTree, notice: event.message };
          }
          break;
        case "submitFailed":
          switch (state.operation.kind) {
            case "cancel":
              return { kind: "confirming" };
            case "complete":
            case "resolve":
              return { kind: "reviewing", changes: state.operation.changes, sinceTree: state.operation.sinceTree, notice: event.message ?? "" };
          }
          break;
        case "openReview":
        case "diffLoaded":
        case "diffFailed":
        case "submitCancel":
        case "submitComplete":
        case "submitResolve":
          return state;
      }
      break;

    case "treeChanged":
      switch (event.kind) {
        case "diffLoaded":
          return { kind: "reviewing", changes: event.changes, sinceTree: state.sinceTree, notice: state.message };
        case "diffFailed":
          return { kind: "loadFailed", sinceTree: state.sinceTree, message: event.message };
        case "dismiss":
          return { kind: "done" };
        case "openReview":
        case "submitCancel":
        case "submitComplete":
        case "submitResolve":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
          return state;
      }
      break;

    case "done":
      switch (event.kind) {
        case "openReview":
        case "diffLoaded":
        case "diffFailed":
        case "submitCancel":
        case "submitComplete":
        case "submitResolve":
        case "submitFailed":
        case "reviewRejected":
        case "completed":
        case "dismiss":
          return state;
      }
  }
}

export function closeDialogSurface(state: CloseFlowState): CloseDialogSurface {
  switch (state.kind) {
    case "confirming":
      return { kind: "confirm", busy: false };
    case "loadingDiff":
    case "treeChanged":
      return { kind: "loading" };
    case "loadFailed":
      return { kind: "error", message: state.message };
    case "reviewing":
      return { kind: "review", changes: state.changes, notice: state.notice, busy: false };
    case "submitting":
      switch (state.operation.kind) {
        case "cancel":
          return { kind: "confirm", busy: true };
        case "complete":
        case "resolve":
          return { kind: "review", changes: state.operation.changes, notice: "", busy: true };
      }
      break;
    case "done":
      return { kind: "done" };
  }
}

export function isCloseDialogWide(state: CloseFlowState): boolean {
  switch (state.kind) {
    case "confirming":
      return false;
    case "submitting":
      return state.operation.kind !== "cancel";
    case "loadingDiff":
    case "loadFailed":
    case "reviewing":
    case "treeChanged":
    case "done":
      return true;
  }
}

export function isCloseDiffEnabled(state: CloseFlowState): boolean {
  switch (state.kind) {
    case "confirming":
    case "done":
      return false;
    case "submitting":
      return state.operation.kind !== "cancel";
    case "loadingDiff":
    case "loadFailed":
    case "reviewing":
    case "treeChanged":
      return true;
  }
}

export function shouldSyncCloseDiff(state: CloseFlowState): boolean {
  switch (state.kind) {
    case "confirming":
    case "submitting":
    case "done":
      return false;
    case "treeChanged":
      return !state.refetch;
    case "loadingDiff":
    case "loadFailed":
    case "reviewing":
      return true;
  }
}

export function sinceTreeOf(state: CloseFlowState): string | undefined {
  switch (state.kind) {
    case "confirming":
    case "done":
      return undefined;
    case "loadingDiff":
    case "loadFailed":
    case "reviewing":
    case "treeChanged":
      return state.sinceTree;
    case "submitting":
      switch (state.operation.kind) {
        case "cancel":
          return undefined;
        case "complete":
        case "resolve":
          return state.operation.sinceTree;
      }
  }
}
