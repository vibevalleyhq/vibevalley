// The owner's acts on an issue, as both issue pages carry them out: the workbench's (pages/issues/IssueDetail.tsx) and
// the farm's (farm/issue/IssueView.tsx). An act is the server's (issue.act); this says which take words from the box,
// which open the box first, which open a dialog, what a reopen tells, and keeps the box, its words and the busy flag.
// A page only says how it runs an act its own way (the farm's commands with their effects) and how it shows a failure.

import { wording } from "@vibevalley/protocol/words";
import { createSignal } from "solid-js";
import type { Issue, IssueAct } from "@vibevalley/protocol";
import { api, newSendKey } from "./api";

/** The box under an issue's ask: the findings of 打回, or a word to the helper. */
export type ActBox = "reject" | "tell";

export interface ActWays {
  /** Runs one act and shows its failure; true when it went through. */
  readonly run: (f: () => Promise<unknown>) => Promise<boolean>;
  /** Acts the page carries out its own way, given the box's words; the rest go to issue.act as they are. */
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

  /** One act with words (or none): the page's own way, else issue.act. */
  const send = (a: IssueAct, words = "") => {
    const own = ways.own?.[a];
    const id = issue().id;
    return act(() => (own ? own(words) : api.issue.act({ id, body: { act: a, ...(words ? { text: words, sendKey: newSendKey() } : {}) } })));
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
    const id = issue().id;
    const words = text().trim();
    void act(async () => {
      const got = await api.issue.act({ id, body: { act: "reopen", ...(words ? { text: words } : {}) } });
      const helper = got.sessions.at(-1);
      if (helper) {
        setText("");
        ways.told("工单重开了", `${helper} 接着做。`);
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
      case "accept":
      case "acknowledge":
      case "resolve":
      case "resume":
      case "cure":
      case "stop":
        return void send(a);
      case "keep":
        break;
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
      a === "reject" && box() === "reject" ? "打回，照上面修" : a === "tell" && box() === "tell" ? "带过去" : (ways.words?.[a] ?? wording().act[a]),
    /** Pressing it now would send nothing. */
    disabled: (a: IssueAct) => busy() || (a === "answer" && !text().trim()) || (a === "reject" && box() === "reject" && !text().trim()),
    /** 打回 with its box open is the red one. */
    rejecting: (a: IssueAct) => a === "reject" && box() === "reject",
  };
}
