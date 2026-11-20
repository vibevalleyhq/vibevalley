export interface NewIssueDraft {
  readonly text: string;
  readonly repo: string;
  readonly agent: string;
}

export interface SubmittedDraft {
  readonly words: string;
  readonly repo: string;
  readonly agent: string;
}

export type DraftSubmitState =
  | { readonly kind: "editing"; readonly draft: NewIssueDraft }
  | { readonly kind: "submitting"; readonly draft: NewIssueDraft; readonly submitted: SubmittedDraft; readonly requestKey: string }
  | { readonly kind: "rejected"; readonly draft: NewIssueDraft; readonly requestKey: string }
  | { readonly kind: "retainedDirty"; readonly draft: NewIssueDraft }
  | { readonly kind: "committed"; readonly draft: NewIssueDraft };

export type DraftSubmitEvent =
  | { readonly kind: "setText"; readonly text: string }
  | { readonly kind: "setRepo"; readonly repo: string }
  | { readonly kind: "setAgent"; readonly agent: string }
  | { readonly kind: "submit" }
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected" };

export function initialDraftSubmit(draft: NewIssueDraft): DraftSubmitState {
  return { kind: "editing", draft };
}

function toSubmittedDraft(draft: NewIssueDraft): SubmittedDraft {
  return { words: draft.text.trim(), repo: draft.repo, agent: draft.agent };
}

function sameDraftPayload(draft: NewIssueDraft, submitted: SubmittedDraft): boolean {
  return draft.text.trim() === submitted.words && draft.repo === submitted.repo && draft.agent === submitted.agent;
}

function applyDraftEdit(draft: NewIssueDraft, event: Extract<DraftSubmitEvent, { readonly kind: "setText" | "setRepo" | "setAgent" }>): NewIssueDraft {
  switch (event.kind) {
    case "setText":
      return event.text === draft.text ? draft : { ...draft, text: event.text };
    case "setRepo":
      return event.repo === draft.repo ? draft : { ...draft, repo: event.repo };
    case "setAgent":
      return event.agent === draft.agent ? draft : { ...draft, agent: event.agent };
  }
}

export function draftSubmitTransition(state: DraftSubmitState, event: DraftSubmitEvent, nextKey: () => string): DraftSubmitState {
  switch (state.kind) {
    case "editing":
      switch (event.kind) {
        case "setText":
        case "setRepo":
        case "setAgent": {
          const draft = applyDraftEdit(state.draft, event);
          return draft === state.draft ? state : { kind: "editing", draft };
        }
        case "submit": {
          const submitted = toSubmittedDraft(state.draft);
          if (!submitted.words) return state;
          return { kind: "submitting", draft: state.draft, submitted, requestKey: nextKey() };
        }
        case "accepted":
        case "rejected":
          return state;
      }

    case "submitting":
      switch (event.kind) {
        case "setText":
        case "setRepo":
        case "setAgent": {
          const draft = applyDraftEdit(state.draft, event);
          return draft === state.draft ? state : { ...state, draft };
        }
        case "accepted":
          return sameDraftPayload(state.draft, state.submitted) ? { kind: "committed", draft: state.draft } : { kind: "retainedDirty", draft: state.draft };
        case "rejected":
          // Reuse requestKey only while the live draft still matches the failed attempt.
          return sameDraftPayload(state.draft, state.submitted)
            ? { kind: "rejected", draft: state.draft, requestKey: state.requestKey }
            : { kind: "editing", draft: state.draft };
        case "submit":
          return state;
      }

    case "rejected":
      switch (event.kind) {
        case "setText":
        case "setRepo":
        case "setAgent": {
          const draft = applyDraftEdit(state.draft, event);
          if (draft === state.draft) return state;
          return sameDraftPayload(draft, toSubmittedDraft(state.draft))
            ? { kind: "rejected", draft, requestKey: state.requestKey }
            : { kind: "editing", draft };
        }
        case "submit": {
          const submitted = toSubmittedDraft(state.draft);
          if (!submitted.words) return state;
          return { kind: "submitting", draft: state.draft, submitted, requestKey: state.requestKey };
        }
        case "accepted":
        case "rejected":
          return state;
      }

    case "retainedDirty":
      switch (event.kind) {
        case "setText":
        case "setRepo":
        case "setAgent": {
          const draft = applyDraftEdit(state.draft, event);
          return draft === state.draft ? state : { kind: "editing", draft };
        }
        case "submit": {
          const submitted = toSubmittedDraft(state.draft);
          if (!submitted.words) return state;
          return { kind: "submitting", draft: state.draft, submitted, requestKey: nextKey() };
        }
        case "accepted":
        case "rejected":
          return state;
      }

    case "committed":
      switch (event.kind) {
        case "setText":
        case "setRepo":
        case "setAgent":
        case "submit":
        case "accepted":
        case "rejected":
          return state;
      }
  }
}

export function isSubmittingDraft(state: DraftSubmitState): boolean {
  switch (state.kind) {
    case "submitting":
      return true;
    case "editing":
    case "rejected":
    case "retainedDirty":
    case "committed":
      return false;
  }
}

export function canSubmitDraft(state: DraftSubmitState): boolean {
  switch (state.kind) {
    case "editing":
    case "rejected":
    case "retainedDirty":
      return state.draft.text.trim().length > 0;
    case "submitting":
    case "committed":
      return false;
  }
}
