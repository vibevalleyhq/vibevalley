// The owner's buttons on an issue, as both issue pages carry them out: the workbench's (features/issue/IssueDetail.tsx)
// and the farm's (farm/issue/IssueView.tsx). What a button sends is the server's (Issue.attention.acts, perform); this
// says which take words from the box, which open the box first, which open a dialog, what a reopen tells, and keeps the
// box, its words and the busy flag. A page only says how it runs a button its own way (the farm's commands with their
// effects) and how it shows a failure.

import { issuesWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import { createSignal } from "solid-js";
import type { Issue, IssueAct, IssueAction } from "@vibevalley/protocol";
import { api, newSendKey } from "../../base/api";

/** Words said again with the same sendKey are said once. */
export function perform(issue: Issue, a: IssueAction, words = "", sendKey = newSendKey()): Promise<unknown> {
  switch (a.does) {
    case "move":
      return api.issue.status.update({ id: issue.id, status: a.status, ...(words ? { text: words } : {}) });
    case "say":
      return api.issue.comment.create({ id: issue.id, text: words, sendKey });
    case "stop": {
      const session = issue.sessions.at(-1);
      return session === undefined ? Promise.resolve() : api.session.stop({ id: session });
    }
  }
}

export const actionOf = (issue: Issue, act: IssueAct) => issue.attention.acts.find((a) => a.act === act);

/** The box under an issue's ask: the findings of 打回, or a word to the helper. */
export type ActBox = "reject" | "tell";

export interface ActWays {
  /** Runs one act and shows its failure; true when it went through. */
  readonly run: (f: () => Promise<unknown>) => Promise<boolean>;
  /** Buttons the page carries out its own way, given the box's words; the rest are sent as the server says (perform). */
  readonly own?: Partial<Record<IssueAct, (words: string) => Promise<unknown>>>;
  /** complete and close open the page's own dialogs. */
  readonly complete: () => void;
  readonly close: () => unknown;
  readonly told: (title: string, description: string) => void;
  /** A skin's own words for some acts (the farm's for complete); the rest are the issue's (wording().act). */
  readonly words?: Partial<Record<IssueAct, string>>;
}

export function createIssueActs(issue: () => Issue, ways: ActWays) {
  const [busy, setBusy] = createSignal(false);
  const [text, setText] = createSignal("");
  const [box, setBox] = createSignal<ActBox | undefined>();

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    const ok = await ways.run(f);
    setBusy(false);
    return ok;
  };

  const send = (a: IssueAct, words = "") => {
    const own = ways.own?.[a];
    const action = actionOf(issue(), a);
    return act(() => (own ? own(words) : action ? perform(issue(), action, words) : Promise.resolve()));
  };

  /** The box's words as the act's; nothing said, nothing sent. The box empties and closes once it went through. */
  const say = (a: IssueAct) => {
    const words = text().trim();
    if (!words) return;
    void send(a, words).then((ok) => {
      if (!ok) return;
      setText("");
      setBox(undefined);
    });
  };

  const reopen = () => {
    const t = issue();
    const action = actionOf(t, "reopen");
    if (action?.does !== "move") return;
    const words = text().trim();
    void act(async () => {
      const got = await api.issue.status.update({ id: t.id, status: action.status, ...(words ? { text: words } : {}) });
      const helper = got.sessions.at(-1);
      if (helper) {
        setText("");
        ways.told(issuesWording().acts.reopened, issuesWording().acts.goesOn(helper));
      }
    });
  };

  const go = (a: IssueAct): void => {
    switch (a) {
      case "complete":
        return ways.complete();
      case "close":
        return void act(async () => ways.close());
      case "answer":
        return say(a);
      case "reject":
      case "tell":
        return box() === a ? say(a) : void setBox(a);
      case "reopen":
        return reopen();
      case "start":
      case "acknowledge":
      case "resolve":
      case "resume":
      case "cure":
      case "stop":
        return void send(a);
    }
  };

  return {
    busy,
    text,
    setText,
    box,
    setBox,
    go,
    send,
    say,
    /** Runs something beside the acts (a review choice) under the same busy flag. */
    act,
    /** What a button says: with its box open, what pressing it again does. */
    label: (a: IssueAct) =>
      a === "reject" && box() === "reject"
        ? issuesWording().acts.rejectWith
        : a === "tell" && box() === "tell"
          ? issuesWording().acts.carry
          : (ways.words?.[a] ?? wording().act[a]),
    /** Pressing it now would send nothing. */
    disabled: (a: IssueAct) => busy() || (a === "answer" && !text().trim()) || (a === "reject" && box() === "reject" && !text().trim()),
    /** 打回 with its box open is the red one. */
    rejecting: (a: IssueAct) => a === "reject" && box() === "reject",
  };
}
