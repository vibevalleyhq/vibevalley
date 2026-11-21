import "../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Changes } from "@vibevalley/protocol";

import {
  closeDialogSurface,
  type CloseFlowEvent,
  type CloseFlowState,
  closeFlowTransition,
  initialCloseFlow,
  isCloseDialogWide,
  isCloseDiffEnabled,
  shouldSyncCloseDiff,
  sinceTreeOf,
} from "../features/issue/model/closeFlow";
import { sampleChanges } from "../features/issue/model/issue.samples";

const changesWithRev = (tree: string, sinceReview?: Changes["sinceReview"]): Changes => ({
  ...sampleChanges,
  revision: { baseCommit: "base", tree },
  ...(sinceReview !== undefined ? { sinceReview } : {}),
});

test("initial states and derived view projections cover confirming and direct review entry", () => {
  const confirming = initialCloseFlow(false);
  expect(confirming).toEqual({ kind: "confirming" });
  expect(isCloseDialogWide(confirming)).toBe(false);
  expect(isCloseDiffEnabled(confirming)).toBe(false);
  expect(shouldSyncCloseDiff(confirming)).toBe(false);
  expect(sinceTreeOf(confirming)).toBeUndefined();
  expect(closeDialogSurface(confirming)).toEqual({ kind: "confirm", busy: false });

  const loading = initialCloseFlow(true);
  expect(loading).toEqual({ kind: "loadingDiff", sinceTree: undefined, notice: "" });
  expect(isCloseDialogWide(loading)).toBe(true);
  expect(isCloseDiffEnabled(loading)).toBe(true);
  expect(shouldSyncCloseDiff(loading)).toBe(true);
  expect(sinceTreeOf(loading)).toBeUndefined();
  expect(closeDialogSurface(loading)).toEqual({ kind: "loading" });
});

test("confirming -> openReview -> diffLoaded -> submitComplete -> completed", () => {
  const initial = initialCloseFlow(false);
  const loading = closeFlowTransition(initial, { kind: "openReview" });
  expect(loading).toEqual({ kind: "loadingDiff", sinceTree: undefined, notice: "" });

  const c1 = changesWithRev("tree-1");
  const reviewing = closeFlowTransition(loading, { kind: "diffLoaded", changes: c1 });
  expect(reviewing).toEqual({ kind: "reviewing", changes: c1, sinceTree: undefined, notice: "" });
  expect(closeDialogSurface(reviewing)).toEqual({ kind: "review", changes: c1, notice: "", busy: false });

  const submitting = closeFlowTransition(reviewing, { kind: "submitComplete" });
  expect(submitting).toEqual({ kind: "submitting", operation: { kind: "complete", changes: c1, sinceTree: undefined } });
  expect(isCloseDialogWide(submitting)).toBe(true);
  expect(isCloseDiffEnabled(submitting)).toBe(true);
  expect(shouldSyncCloseDiff(submitting)).toBe(false);
  expect(closeDialogSurface(submitting)).toEqual({ kind: "review", changes: c1, notice: "", busy: true });

  const done = closeFlowTransition(submitting, { kind: "completed" });
  expect(done).toEqual({ kind: "done" });
  expect(isCloseDiffEnabled(done)).toBe(false);
  expect(closeDialogSurface(done)).toEqual({ kind: "done" });
});

test("bizCode 300001 review rejection transitions to treeChanged, requests incremental diff, preserves notice, and completes", () => {
  const seen = changesWithRev("seen");
  const incremental = changesWithRev("new", [{ path: "updated.txt", status: "M", added: 1, removed: 0 }]);

  let state: CloseFlowState = initialCloseFlow(true);
  state = closeFlowTransition(state, { kind: "diffLoaded", changes: seen });
  state = closeFlowTransition(state, { kind: "submitComplete" });

  state = closeFlowTransition(state, { kind: "reviewRejected", message: "review changed", bizCode: 300001 });
  expect(state).toEqual({ kind: "treeChanged", sinceTree: "seen", message: "review changed", refetch: false });
  expect(sinceTreeOf(state)).toBe("seen");
  expect(isCloseDiffEnabled(state)).toBe(true);
  expect(shouldSyncCloseDiff(state)).toBe(true);
  expect(closeDialogSurface(state)).toEqual({ kind: "loading" });

  state = closeFlowTransition(state, { kind: "diffLoaded", changes: incremental });
  expect(state).toEqual({ kind: "reviewing", changes: incremental, sinceTree: "seen", notice: "review changed" });
  expect(sinceTreeOf(state)).toBe("seen");
  expect(closeDialogSurface(state)).toEqual({ kind: "review", changes: incremental, notice: "review changed", busy: false });

  state = closeFlowTransition(state, { kind: "submitComplete" });
  expect(state).toEqual({ kind: "submitting", operation: { kind: "complete", changes: incremental, sinceTree: "seen" } });
  expect(sinceTreeOf(state)).toBe("seen");

  state = closeFlowTransition(state, { kind: "completed" });
  expect(state).toEqual({ kind: "done" });
});

test("review rejection with unchanged sinceTree or missing revision requests explicit refetch and pauses auto-sync", () => {
  const sameTree = changesWithRev("seen");
  const reviewingSame: CloseFlowState = { kind: "reviewing", changes: sameTree, sinceTree: "seen", notice: "" };
  const submittingSame = closeFlowTransition(reviewingSame, { kind: "submitComplete" });
  const refetched = closeFlowTransition(submittingSame, { kind: "reviewRejected", message: "still changing", bizCode: 300001 });
  expect(refetched).toEqual({ kind: "treeChanged", sinceTree: "seen", message: "still changing", refetch: true });
  expect(shouldSyncCloseDiff(refetched)).toBe(false);

  const afterRefetch = closeFlowTransition(refetched, { kind: "diffLoaded", changes: changesWithRev("newer") });
  expect(afterRefetch.kind).toBe("reviewing");
  if (afterRefetch.kind === "reviewing") {
    expect(afterRefetch.notice).toBe("still changing");
    expect(afterRefetch.sinceTree).toBe("seen");
  }

  const { revision: _, ...withoutRev } = sampleChanges;
  const submittingNoRev = closeFlowTransition({ kind: "reviewing", changes: withoutRev, sinceTree: undefined, notice: "" }, { kind: "submitComplete" });
  const refetchedNoRev = closeFlowTransition(submittingNoRev, { kind: "reviewRejected", message: "refused", bizCode: 300002 });
  expect(refetchedNoRev).toEqual({ kind: "treeChanged", sinceTree: undefined, message: "refused", refetch: true });
  expect(shouldSyncCloseDiff(refetchedNoRev)).toBe(false);

  const secondMove = closeFlowTransition(
    closeFlowTransition({ kind: "reviewing", changes: changesWithRev("new"), sinceTree: "seen", notice: "" }, { kind: "submitComplete" }),
    { kind: "reviewRejected", message: "moved again", bizCode: 300002 },
  );
  expect(secondMove).toEqual({ kind: "treeChanged", sinceTree: "new", message: "moved again", refetch: false });
});

test("cancel, resolve, loadFailed recovery, and submitFailed transitions keep consistent state", () => {
  const cancelling = closeFlowTransition(initialCloseFlow(false), { kind: "submitCancel" });
  expect(cancelling).toEqual({ kind: "submitting", operation: { kind: "cancel" } });
  expect(isCloseDialogWide(cancelling)).toBe(false);
  expect(isCloseDiffEnabled(cancelling)).toBe(false);
  expect(sinceTreeOf(cancelling)).toBeUndefined();
  expect(closeDialogSurface(cancelling)).toEqual({ kind: "confirm", busy: true });

  expect(closeFlowTransition(cancelling, { kind: "submitFailed" })).toEqual({ kind: "confirming" });
  expect(closeFlowTransition(cancelling, { kind: "reviewRejected", message: "cannot cancel" })).toEqual({ kind: "confirming" });
  expect(closeFlowTransition(cancelling, { kind: "completed" })).toEqual({ kind: "done" });

  const failed = closeFlowTransition(initialCloseFlow(true), { kind: "diffFailed", message: "git failed" });
  expect(failed).toEqual({ kind: "loadFailed", sinceTree: undefined, message: "git failed" });
  expect(closeDialogSurface(failed)).toEqual({ kind: "error", message: "git failed" });
  expect(closeFlowTransition(failed, { kind: "diffFailed", message: "git failed" })).toBe(failed);
  expect(closeFlowTransition(failed, { kind: "diffFailed", message: "git timeout" })).toEqual({
    kind: "loadFailed",
    sinceTree: undefined,
    message: "git timeout",
  });

  const c1 = changesWithRev("t1");
  const recovered = closeFlowTransition(failed, { kind: "diffLoaded", changes: c1 });
  expect(recovered).toEqual({ kind: "reviewing", changes: c1, sinceTree: undefined, notice: "" });

  const resolving = closeFlowTransition(recovered, { kind: "submitResolve" });
  expect(resolving).toEqual({ kind: "submitting", operation: { kind: "resolve", changes: c1, sinceTree: undefined } });
  expect(closeFlowTransition(resolving, { kind: "submitFailed", message: "offline" })).toEqual({
    kind: "reviewing",
    changes: c1,
    sinceTree: undefined,
    notice: "offline",
  });
  expect(closeFlowTransition(resolving, { kind: "reviewRejected", message: "cannot resolve" })).toEqual({
    kind: "reviewing",
    changes: c1,
    sinceTree: undefined,
    notice: "cannot resolve",
  });
  expect(closeFlowTransition(resolving, { kind: "completed" })).toEqual({ kind: "done" });

  const treeFailed = closeFlowTransition(
    { kind: "treeChanged", sinceTree: "seen", message: "review changed", refetch: false },
    { kind: "diffFailed", message: "boom" },
  );
  expect(treeFailed).toEqual({ kind: "loadFailed", sinceTree: "seen", message: "boom" });
});

test("re-entrancy, referential stability, dismiss, and terminal done guards reject illegal events", () => {
  const c1 = changesWithRev("t1");
  const c2 = changesWithRev("t2");

  const reviewing: CloseFlowState = { kind: "reviewing", changes: c1, sinceTree: "s0", notice: "note" };
  expect(closeFlowTransition(reviewing, { kind: "diffLoaded", changes: c1 })).toBe(reviewing);
  expect(closeFlowTransition(reviewing, { kind: "diffLoaded", changes: c2 })).toEqual({
    kind: "reviewing",
    changes: c2,
    sinceTree: "s0",
    notice: "note",
  });
  expect(closeFlowTransition(reviewing, { kind: "diffFailed", message: "broken" })).toEqual({
    kind: "loadFailed",
    sinceTree: "s0",
    message: "broken",
  });

  const submitting = closeFlowTransition(reviewing, { kind: "submitComplete" });
  for (const ignored of [
    { kind: "openReview" },
    { kind: "diffLoaded", changes: c2 },
    { kind: "diffFailed", message: "err" },
    { kind: "submitCancel" },
    { kind: "submitComplete" },
    { kind: "submitResolve" },
  ] satisfies CloseFlowEvent[]) {
    expect(closeFlowTransition(submitting, ignored)).toBe(submitting);
  }
  expect(closeFlowTransition(submitting, { kind: "submitFailed", message: "offline" })).toEqual({
    kind: "reviewing",
    changes: c1,
    sinceTree: "s0",
    notice: "offline",
  });

  const confirming = initialCloseFlow(false);
  for (const ignored of [
    { kind: "diffLoaded", changes: c1 },
    { kind: "diffFailed", message: "err" },
    { kind: "submitComplete" },
    { kind: "submitResolve" },
    { kind: "submitFailed", message: "err" },
    { kind: "reviewRejected", message: "err" },
    { kind: "completed" },
  ] satisfies CloseFlowEvent[]) {
    expect(closeFlowTransition(confirming, ignored)).toBe(confirming);
  }

  const allNonTerminal: CloseFlowState[] = [
    confirming,
    initialCloseFlow(true),
    { kind: "loadFailed", sinceTree: undefined, message: "err" },
    reviewing,
    submitting,
    { kind: "treeChanged", sinceTree: "t1", message: "changed", refetch: false },
  ];
  for (const state of allNonTerminal) {
    expect(closeFlowTransition(state, { kind: "dismiss" })).toEqual({ kind: "done" });
  }

  const done: CloseFlowState = { kind: "done" };
  for (const event of [
    { kind: "openReview" },
    { kind: "diffLoaded", changes: c1 },
    { kind: "diffFailed", message: "err" },
    { kind: "submitCancel" },
    { kind: "submitComplete" },
    { kind: "submitResolve" },
    { kind: "submitFailed", message: "err" },
    { kind: "reviewRejected", message: "err", bizCode: 300001 },
    { kind: "completed" },
    { kind: "dismiss" },
  ] satisfies CloseFlowEvent[]) {
    expect(closeFlowTransition(done, event)).toBe(done);
  }
});
