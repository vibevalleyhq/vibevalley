// Ported from VibeValley apps/web/src/features/issue/views/NewIssue.tsx:
// the sheet that writes a new issue from a few words. Command+Return keeps
// it (a key binding while the sheet is up), as the form's submit did.
import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { useWorkAgents } from "../../../infra/agents";
import { newSendKey } from "../../../infra/api";
import { ready, useRepos } from "../../../infra/query";
import { prefsNow } from "../../../state/prefs";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Select, TextArea } from "../../../ui/Field";
import { toast } from "../../../ui/toasts";
import { canSubmitDraft, type DraftSubmitEvent, type DraftSubmitState, draftSubmitTransition, initialDraftSubmit } from "../model/draftSubmit";

/** The repo and helper the board is filtered to, or the list group it was opened in. */
export interface NewIssueAt {
  readonly repo?: string;
  readonly agent?: string;
}

export function NewIssue(props: { at: NewIssueAt; onKeep: (words: string, where: NewIssueAt, requestKey: string) => Promise<boolean>; onClose: () => void }) {
  const last = prefsNow();
  const flow = signal<DraftSubmitState>(
    initialDraftSubmit({
      text: "",
      repo: props.at.repo ?? last.repo,
      agent: props.at.agent ?? (last.pick === "auto" ? "" : last.pick),
    }),
  );
  const dispatch = (event: DraftSubmitEvent): DraftSubmitState => {
    const next = draftSubmitTransition(untracked(flow), event, newSendKey);
    flow.set(next);
    return next;
  };
  const draft = () => flow().draft;
  const agents = useWorkAgents(true);
  const repoList = useRepos();
  const repos = () => ready(repoList, []).map((p) => p.name);
  const textFocused = signal(true);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const keep = async () => {
    if (!canSubmitDraft(untracked(flow))) return;
    const started = dispatch({ kind: "submit" });
    if (started.kind !== "submitting") return;
    const { submitted, requestKey } = started;
    let kept = false;
    try {
      kept = await props.onKeep(
        submitted.words,
        { ...(submitted.repo ? { repo: submitted.repo } : {}), ...(submitted.agent ? { agent: submitted.agent } : {}) },
        requestKey,
      );
    } catch (error) {
      if (mounted) dispatch({ kind: "rejected" });
      throw error;
    }
    if (!mounted) return;
    const settled = dispatch({ kind: kept ? "accepted" : "rejected" });
    switch (settled.kind) {
      case "committed":
        props.onClose();
        break;
      case "retainedDirty":
        toast(t("web.issue.new.editsKept"));
        break;
      case "editing":
      case "submitting":
      case "rejected":
        break;
    }
  };
  keymap.bind("mod+enter", () => void keep(), { when: "always" });
  effect(() => {
    if (textFocused()) return keymap.bind("escape", props.onClose, { when: "always" });
  });
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.new.title")} testid="issue-new-dialog">
      <View class="gap-3">
        <TextArea
          testID="issue-new-text"
          accessibilityLabel={t("web.issue.new.words")}
          placeholder={t("web.issue.new.placeholder")}
          rows={4}
          value={draft().text}
          autoFocus
          onInput={(text) => dispatch({ kind: "setText", text })}
          onFocus={() => textFocused.set(true)}
          onBlur={() => textFocused.set(false)}
        />
        <View class="flex-row flex-wrap items-center gap-2">
          <Select
            quiet
            size="control"
            label={t("web.issue.task.repo")}
            testid="issue-new-repo"
            value={draft().repo}
            placeholder={t("web.issue.todo.whichRepo")}
            onChange={(repo) => dispatch({ kind: "setRepo", repo })}
            options={[...new Set([...repos(), ...(draft().repo ? [draft().repo] : [])])].map((p) => ({ value: p, label: p }))}
          />
          <Select
            quiet
            size="control"
            label={t("web.issue.detail.helper")}
            testid="issue-new-helper"
            value={draft().agent}
            placeholder={t("web.issue.todo.pickForMe")}
            onChange={(agent) => dispatch({ kind: "setAgent", agent })}
            options={agents().map((a) => ({ value: a.id, label: a.name }))}
          />
        </View>
        <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
          <Text class="mr-auto text-xs text-faint">{t("web.issue.new.keys")}</Text>
          <Button tone="quiet" testID="issue-new-dialog-never" onPress={() => props.onClose()}>
            {t("web.base.form.never")}
          </Button>
          <Button tone="primary" testID="issue-new-keep" disabled={!canSubmitDraft(flow())} onPress={() => void keep()}>
            {t("web.issue.new.keep")}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
