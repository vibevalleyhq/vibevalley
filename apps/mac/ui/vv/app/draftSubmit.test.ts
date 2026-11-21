import "../polyfill";
import { expect, test } from "nsh/test";

import {
  canSubmitDraft,
  type DraftSubmitEvent,
  type DraftSubmitState,
  draftSubmitTransition,
  initialDraftSubmit,
  isSubmittingDraft,
} from "../web/features/issue/model/draftSubmit";

const keyCounter = () => {
  let n = 0;
  return () => `key-${++n}`;
};

test("empty or whitespace-only drafts cannot submit and never mint a requestKey", () => {
  const nextKey = keyCounter();
  let state = initialDraftSubmit({ text: "", repo: "app", agent: "a1" });
  expect(canSubmitDraft(state)).toBe(false);
  expect(isSubmittingDraft(state)).toBe(false);
  expect(draftSubmitTransition(state, { kind: "submit" }, nextKey)).toBe(state);

  state = draftSubmitTransition(state, { kind: "setText", text: "   \n\t " }, nextKey);
  expect(canSubmitDraft(state)).toBe(false);
  expect(draftSubmitTransition(state, { kind: "submit" }, nextKey)).toBe(state);

  state = draftSubmitTransition(state, { kind: "setText", text: "Add forgot password" }, nextKey);
  expect(canSubmitDraft(state)).toBe(true);
  const submitting = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(submitting).toEqual({
    kind: "submitting",
    draft: { text: "Add forgot password", repo: "app", agent: "a1" },
    submitted: { words: "Add forgot password", repo: "app", agent: "a1" },
    requestKey: "key-1",
  });
  expect(isSubmittingDraft(submitting)).toBe(true);
  expect(canSubmitDraft(submitting)).toBe(false);
});

test("retry after rejection reuses identical requestKey while payload is unchanged", () => {
  const nextKey = keyCounter();
  let state: DraftSubmitState = initialDraftSubmit({ text: "  Login fix  ", repo: "web", agent: "zhou" });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind !== "submitting") return;
  expect(state.requestKey).toBe("key-1");

  state = draftSubmitTransition(state, { kind: "rejected" }, nextKey);
  expect(state).toEqual({
    kind: "rejected",
    draft: { text: "  Login fix  ", repo: "web", agent: "zhou" },
    requestKey: "key-1",
  });
  expect(canSubmitDraft(state)).toBe(true);
  expect(isSubmittingDraft(state)).toBe(false);

  state = draftSubmitTransition(state, { kind: "setText", text: "Login fix" }, nextKey);
  expect(state).toEqual({
    kind: "rejected",
    draft: { text: "Login fix", repo: "web", agent: "zhou" },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "Login fix", repo: "web", agent: "zhou" },
    submitted: { words: "Login fix", repo: "web", agent: "zhou" },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "committed",
    draft: { text: "Login fix", repo: "web", agent: "zhou" },
  });
  expect(canSubmitDraft(state)).toBe(false);
});

test("editing text, repo, or agent after rejection clears rejected state and rotates requestKey", () => {
  const mutations: DraftSubmitEvent[] = [
    { kind: "setText", text: "Second draft" },
    { kind: "setRepo", repo: "other-repo" },
    { kind: "setAgent", agent: "other-agent" },
  ];

  for (const edit of mutations) {
    const nextKey = keyCounter();
    let state: DraftSubmitState = initialDraftSubmit({ text: "First draft", repo: "repo-a", agent: "agent-a" });
    state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
    state = draftSubmitTransition(state, { kind: "rejected" }, nextKey);
    expect(state.kind).toBe("rejected");

    state = draftSubmitTransition(state, edit, nextKey);
    expect(state.kind).toBe("editing");

    state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
    expect(state.kind).toBe("submitting");
    if (state.kind === "submitting") {
      expect(state.requestKey).toBe("key-2");
    }
  }
});

test("draft mutation during in-flight submit transitions to retainedDirty on accept and rotates requestKey", () => {
  const nextKey = keyCounter();
  let state: DraftSubmitState = initialDraftSubmit({ text: "First", repo: "repo-a", agent: "agent-a" });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind !== "submitting") return;
  expect(state.requestKey).toBe("key-1");

  state = draftSubmitTransition(state, { kind: "setText", text: "FirstChanged" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a" },
    submitted: { words: "First", repo: "repo-a", agent: "agent-a" },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "retainedDirty",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a" },
  });
  expect(canSubmitDraft(state)).toBe(true);

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a" },
    submitted: { words: "FirstChanged", repo: "repo-a", agent: "agent-a" },
    requestKey: "key-2",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "committed",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a" },
  });
});

test("in-flight repo or agent change retains draft on accept, and reverting before accept commits cleanly", () => {
  const nextKey = keyCounter();
  let state: DraftSubmitState = initialDraftSubmit({ text: "Ship it", repo: "r1", agent: "a1" });
  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  state = draftSubmitTransition(state, { kind: "setRepo", repo: "r2" }, nextKey);
  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state.kind).toBe("retainedDirty");

  state = draftSubmitTransition(state, { kind: "setText", text: "   " }, nextKey);
  expect(state.kind).toBe("editing");
  expect(canSubmitDraft(state)).toBe(false);

  let reverted: DraftSubmitState = initialDraftSubmit({ text: "Same", repo: "r1", agent: "a1" });
  reverted = draftSubmitTransition(reverted, { kind: "submit" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "setAgent", agent: "a2" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "setAgent", agent: "a1" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "accepted" }, nextKey);
  expect(reverted.kind).toBe("committed");
});

test("in-flight edit followed by rejection drops stale requestKey and rotates on next submit", () => {
  const nextKey = keyCounter();
  let state: DraftSubmitState = initialDraftSubmit({ text: "Original", repo: "", agent: "" });
  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  state = draftSubmitTransition(state, { kind: "setText", text: "Edited while in flight" }, nextKey);

  state = draftSubmitTransition(state, { kind: "rejected" }, nextKey);
  expect(state).toEqual({
    kind: "editing",
    draft: { text: "Edited while in flight", repo: "", agent: "" },
  });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind === "submitting") {
    expect(state.requestKey).toBe("key-2");
  }
});

test("re-entrancy during submitting and terminal committed state ignore illegal events", () => {
  const nextKey = keyCounter();
  const editing = initialDraftSubmit({ text: "Task", repo: "", agent: "" });
  expect(draftSubmitTransition(editing, { kind: "accepted" }, nextKey)).toBe(editing);
  expect(draftSubmitTransition(editing, { kind: "rejected" }, nextKey)).toBe(editing);

  const submitting = draftSubmitTransition(editing, { kind: "submit" }, nextKey);
  expect(draftSubmitTransition(submitting, { kind: "submit" }, nextKey)).toBe(submitting);

  const committed = draftSubmitTransition(submitting, { kind: "accepted" }, nextKey);
  for (const event of [
    { kind: "setText", text: "ignored" },
    { kind: "setRepo", repo: "ignored" },
    { kind: "setAgent", agent: "ignored" },
    { kind: "submit" },
    { kind: "accepted" },
    { kind: "rejected" },
  ] satisfies DraftSubmitEvent[]) {
    expect(draftSubmitTransition(committed, event, nextKey)).toBe(committed);
  }
});
