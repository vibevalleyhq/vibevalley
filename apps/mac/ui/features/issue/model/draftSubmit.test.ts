import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Attachment } from "@vibevalley/protocol";

import { canSubmitDraft, type DraftSubmitEvent, type DraftSubmitState, draftSubmitTransition, initialDraftSubmit, isSubmittingDraft } from "./draftSubmit";

const keyCounter = () => {
  let n = 0;
  return () => `key-${++n}`;
};

const sampleFile = (id: string, name = `${id}.png`): Attachment => ({
  id,
  name,
  type: "image/png",
  size: 1024,
});

test("empty or whitespace-only drafts cannot submit and never mint a requestKey", () => {
  const nextKey = keyCounter();
  let state = initialDraftSubmit({ text: "", repo: "app", agent: "a1", attachments: [] });
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
    draft: { text: "Add forgot password", repo: "app", agent: "a1", attachments: [] },
    submitted: { words: "Add forgot password", repo: "app", agent: "a1", attachments: [] },
    requestKey: "key-1",
  });
  expect(isSubmittingDraft(submitting)).toBe(true);
  expect(canSubmitDraft(submitting)).toBe(false);
});

test("retry after rejection reuses identical requestKey while payload is unchanged", () => {
  const nextKey = keyCounter();
  const file = sampleFile("att-1");
  let state: DraftSubmitState = initialDraftSubmit({ text: "  Login fix  ", repo: "web", agent: "zhou", attachments: [file] });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind !== "submitting") return;
  expect(state.requestKey).toBe("key-1");

  state = draftSubmitTransition(state, { kind: "rejected" }, nextKey);
  expect(state).toEqual({
    kind: "rejected",
    draft: { text: "  Login fix  ", repo: "web", agent: "zhou", attachments: [file] },
    requestKey: "key-1",
  });
  expect(canSubmitDraft(state)).toBe(true);
  expect(isSubmittingDraft(state)).toBe(false);

  state = draftSubmitTransition(state, { kind: "setText", text: "Login fix" }, nextKey);
  expect(state).toEqual({
    kind: "rejected",
    draft: { text: "Login fix", repo: "web", agent: "zhou", attachments: [file] },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "Login fix", repo: "web", agent: "zhou", attachments: [file] },
    submitted: { words: "Login fix", repo: "web", agent: "zhou", attachments: [file] },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "committed",
    draft: { text: "Login fix", repo: "web", agent: "zhou", attachments: [file] },
  });
  expect(canSubmitDraft(state)).toBe(false);
});

test("editing text, repo, agent, or attachments after rejection clears rejected state and rotates requestKey", () => {
  const initialFile = sampleFile("att-1");
  const mutations: DraftSubmitEvent[] = [
    { kind: "setText", text: "Second draft" },
    { kind: "setRepo", repo: "other-repo" },
    { kind: "setAgent", agent: "other-agent" },
    { kind: "addAttachment", file: sampleFile("att-2") },
    { kind: "removeAttachment", id: "att-1" },
  ];

  for (const edit of mutations) {
    const nextKey = keyCounter();
    let state: DraftSubmitState = initialDraftSubmit({ text: "First draft", repo: "repo-a", agent: "agent-a", attachments: [initialFile] });
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
  let state: DraftSubmitState = initialDraftSubmit({ text: "First", repo: "repo-a", agent: "agent-a", attachments: [] });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind !== "submitting") return;
  expect(state.requestKey).toBe("key-1");

  state = draftSubmitTransition(state, { kind: "setText", text: "FirstChanged" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a", attachments: [] },
    submitted: { words: "First", repo: "repo-a", agent: "agent-a", attachments: [] },
    requestKey: "key-1",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "retainedDirty",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a", attachments: [] },
  });
  expect(canSubmitDraft(state)).toBe(true);

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state).toEqual({
    kind: "submitting",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a", attachments: [] },
    submitted: { words: "FirstChanged", repo: "repo-a", agent: "agent-a", attachments: [] },
    requestKey: "key-2",
  });

  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state).toEqual({
    kind: "committed",
    draft: { text: "FirstChanged", repo: "repo-a", agent: "agent-a", attachments: [] },
  });
});

test("in-flight repo, agent, or attachment change retains draft on accept, and reverting before accept commits cleanly", () => {
  const nextKey = keyCounter();
  const file = sampleFile("att-9");
  let state: DraftSubmitState = initialDraftSubmit({ text: "Ship it", repo: "r1", agent: "a1", attachments: [] });
  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  state = draftSubmitTransition(state, { kind: "setRepo", repo: "r2" }, nextKey);
  state = draftSubmitTransition(state, { kind: "accepted" }, nextKey);
  expect(state.kind).toBe("retainedDirty");

  state = draftSubmitTransition(state, { kind: "setText", text: "   " }, nextKey);
  expect(state.kind).toBe("editing");
  expect(canSubmitDraft(state)).toBe(false);

  let reverted: DraftSubmitState = initialDraftSubmit({ text: "Same", repo: "r1", agent: "a1", attachments: [] });
  reverted = draftSubmitTransition(reverted, { kind: "submit" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "setAgent", agent: "a2" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "setAgent", agent: "a1" }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "addAttachment", file }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "removeAttachment", id: file.id }, nextKey);
  reverted = draftSubmitTransition(reverted, { kind: "accepted" }, nextKey);
  expect(reverted.kind).toBe("committed");

  let attachedInFlight: DraftSubmitState = initialDraftSubmit({ text: "Same", repo: "r1", agent: "a1", attachments: [] });
  attachedInFlight = draftSubmitTransition(attachedInFlight, { kind: "submit" }, nextKey);
  attachedInFlight = draftSubmitTransition(attachedInFlight, { kind: "addAttachment", file }, nextKey);
  attachedInFlight = draftSubmitTransition(attachedInFlight, { kind: "accepted" }, nextKey);
  expect(attachedInFlight).toEqual({
    kind: "retainedDirty",
    draft: { text: "Same", repo: "r1", agent: "a1", attachments: [file] },
  });
});

test("addAttachment deduplicates by id and removeAttachment ignores unknown ids", () => {
  const nextKey = keyCounter();
  const file = sampleFile("att-1");
  let state = initialDraftSubmit({ text: "Bug", repo: "", agent: "", attachments: [] });
  state = draftSubmitTransition(state, { kind: "addAttachment", file }, nextKey);
  expect(state.draft.attachments).toEqual([file]);
  expect(draftSubmitTransition(state, { kind: "addAttachment", file }, nextKey)).toBe(state);
  expect(draftSubmitTransition(state, { kind: "removeAttachment", id: "missing" }, nextKey)).toBe(state);
  state = draftSubmitTransition(state, { kind: "removeAttachment", id: file.id }, nextKey);
  expect(state.draft.attachments).toEqual([]);
});

test("in-flight edit followed by rejection drops stale requestKey and rotates on next submit", () => {
  const nextKey = keyCounter();
  let state: DraftSubmitState = initialDraftSubmit({ text: "Original", repo: "", agent: "", attachments: [] });
  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  state = draftSubmitTransition(state, { kind: "setText", text: "Edited while in flight" }, nextKey);

  state = draftSubmitTransition(state, { kind: "rejected" }, nextKey);
  expect(state).toEqual({
    kind: "editing",
    draft: { text: "Edited while in flight", repo: "", agent: "", attachments: [] },
  });

  state = draftSubmitTransition(state, { kind: "submit" }, nextKey);
  expect(state.kind).toBe("submitting");
  if (state.kind === "submitting") {
    expect(state.requestKey).toBe("key-2");
  }
});

test("re-entrancy during submitting and terminal committed state ignore illegal events", () => {
  const nextKey = keyCounter();
  const editing = initialDraftSubmit({ text: "Task", repo: "", agent: "", attachments: [] });
  expect(draftSubmitTransition(editing, { kind: "accepted" }, nextKey)).toBe(editing);
  expect(draftSubmitTransition(editing, { kind: "rejected" }, nextKey)).toBe(editing);

  const submitting = draftSubmitTransition(editing, { kind: "submit" }, nextKey);
  expect(draftSubmitTransition(submitting, { kind: "submit" }, nextKey)).toBe(submitting);

  const committed = draftSubmitTransition(submitting, { kind: "accepted" }, nextKey);
  for (const event of [
    { kind: "setText", text: "ignored" },
    { kind: "setRepo", repo: "ignored" },
    { kind: "setAgent", agent: "ignored" },
    { kind: "addAttachment", file: sampleFile("ignored") },
    { kind: "removeAttachment", id: "ignored" },
    { kind: "submit" },
    { kind: "accepted" },
    { kind: "rejected" },
  ] satisfies DraftSubmitEvent[]) {
    expect(draftSubmitTransition(committed, event, nextKey)).toBe(committed);
  }
});
