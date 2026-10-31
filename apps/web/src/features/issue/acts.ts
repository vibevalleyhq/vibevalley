import { createSignal } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Issue, type IssueAct, type IssueAction, type IssueStatus } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api } from "@/infra/api";
import { useIntents } from "@/state/intent";
import type { Act } from "@/ui/act";

import { issueMove, issueMoveOf, sendMove } from "./moves";
import { issueSay, pendingWords } from "./say";

// The owner's buttons on an issue, as both issue pages carry them out: the workbench's (features/issue/IssueDetail.tsx)
// and the farm's (farm/issue/IssueView.tsx). What a button sends is the server's (Issue.attention.acts); a move and words
// go as intents (moves.ts, say.ts), shown on the page until the frame has them, and the rest through the page's Act.
// This says which take words from the box, which open the box first, which open a dialog, what a reopen tells, and keeps
// the box and its words. A page only says how it runs a button its own way (the farm's commands with their effects).

/**
 * An action sent once, without an overlay (the farm's bed tools, which play their effect after it). Words said take the
 * caller's sendKey, kept until they went through, so said again they are said once.
 */
export function perform(issue: Issue, a: IssueAction, words = "", sendKey = ""): Promise<unknown> {
  switch (a.does) {
    case "move":
      return api.issue.status.update({ id: issue.id, status: a.status, ...(words ? { text: words } : {}) });
    case "say":
      return api.issue.comment.create({ id: issue.id, text: words, ...(sendKey ? { sendKey } : {}) });
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
  /** Runs what shows nothing before the server has it, and says its refusal: the workbench's Act or the farm's. */
  readonly act: Act;
  /** Buttons the page carries out its own way, given the box's words; the rest are sent as the server says. */
  readonly own?: Partial<Record<IssueAct, (words: string) => Promise<unknown>>>;
  /** complete and close open the page's own dialogs. */
  readonly complete: () => void;
  readonly close: () => unknown;
  readonly told: (title: string, description: string) => void;
  /** A skin's own words for some acts (the farm's for complete); the rest are the issue's (wording().act). */
  readonly words?: Partial<Record<IssueAct, string>>;
  /** The server took an act sent through the intents or the Act (the farm plays the bed's effect then). */
  readonly done?: (a: IssueAct) => void;
}

export function createIssueActs(issue: () => Issue, ways: ActWays) {
  const moves = useIntents(issueMove);
  const says = useIntents(issueSay);
  const [text, setText] = createSignal("");
  const [box, setBox] = createSignal<ActBox | undefined>();

  const move = () => issueMoveOf(issue().id, moves.list());
  // A move on its way changes what the buttons mean: none is pressed until the frame shows where the issue is.
  const busy = () => ways.act.busy() || move()?.state === "moving";
  const run = (f: () => Promise<unknown>) => ways.act.run(async () => (await f(), true)).then((ok) => ok === true);

  /** True once the server took it; a failed move shows on the page with why. */
  const moveTo = async (a: IssueAct, status: IssueStatus, words: string) => {
    const done = await sendMove(moves, omitUndefined({ id: issue().id, status, text: words || undefined })).done;
    const ok = done !== undefined && done.status !== "failed";
    if (ok) ways.done?.(a);
    return ok;
  };

  /** The words leave the box at once and show under it until the frame has them. */
  const sayIt = (a: IssueAct, words: string) => {
    const said = words.trim();
    if (!said) return Promise.resolve(false);
    void says.send({ id: issue().id, text: said }).done.then((done) => done?.replied !== undefined && ways.done?.(a));
    return Promise.resolve(true);
  };

  const send = (a: IssueAct, words = ""): Promise<boolean> => {
    const own = ways.own?.[a];
    if (own) return run(() => own(words));
    const action = actionOf(issue(), a);
    if (!action) return Promise.resolve(false);
    switch (action.does) {
      case "move":
        return moveTo(a, action.status, words);
      case "say":
        return sayIt(a, words);
      case "stop":
        return run(() => perform(issue(), action)).then((ok) => {
          if (ok) ways.done?.(a);
          return ok;
        });
    }
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
    const current = issue();
    const action = actionOf(current, "reopen");
    if (action?.does !== "move") return;
    const words = text().trim();
    void sendMove(moves, omitUndefined({ id: current.id, status: action.status, text: words || undefined })).done.then((done) => {
      const helper = done?.replied?.reply.sessions.at(-1);
      if (!helper) return;
      setText("");
      ways.told(t("web.issue.acts.reopened"), t("web.issue.acts.goesOn", { helper }));
    });
  };

  const go = (a: IssueAct): void => {
    switch (a) {
      case "complete":
        return ways.complete();
      case "close":
        return void ways.close();
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
    run,
    /** The words said here on their way, or refused. */
    words: () => pendingWords(says.list(), issue().id),
    sayAgain: (key: string) => void says.retry(key),
    /** A refused line back into the box, to change or let go. */
    takeBack: (key: string) => {
      const back = says.drop(key);
      if (back) setText(back.input.text);
    },
    /** What a button says: with its box open, what pressing it again does. */
    label: (a: IssueAct) =>
      a === "reject" && box() === "reject"
        ? t("web.issue.acts.rejectWith")
        : a === "tell" && box() === "tell"
          ? t("web.issue.acts.carry")
          : (ways.words?.[a] ?? t(`shared.act.${a}`)),
    /** Pressing it now would send nothing. */
    disabled: (a: IssueAct) => busy() || (a === "answer" && !text().trim()) || (a === "reject" && box() === "reject" && !text().trim()),
    /** 打回 with its box open is the red one. */
    rejecting: (a: IssueAct) => a === "reject" && box() === "reject",
  };
}
