// Ported from VibeValley apps/web/src/features/issue/views/NewIssue.tsx:
// the sheet that writes a new issue from a few words. Command+Return keeps
// it (a key binding while the sheet is up), as the form's submit did.
import { keymap, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { useWorkAgents } from "../../../infra/agents";
import { ready, useRepos } from "../../../infra/query";
import { prefsNow } from "../../../state/prefs";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Select, TextArea } from "../../../ui/Field";

/** The repo and helper the board is filtered to, or the list group it was opened in. */
export interface NewIssueAt {
  readonly repo?: string;
  readonly agent?: string;
}

export function NewIssue(props: { at: NewIssueAt; onKeep: (words: string, where: NewIssueAt) => void; onClose: () => void }) {
  const text = signal("");
  // What it was opened with, else what the last issue was given: shown as it will be used (write.ts falls back the same).
  const last = prefsNow();
  const repo = signal(props.at.repo ?? last.repo);
  const agent = signal(props.at.agent ?? (last.pick === "auto" ? "" : last.pick));
  const agents = useWorkAgents(true);
  const repoList = useRepos();
  const repos = () => ready(repoList, []).map((p) => p.name);
  const keep = () => {
    const words = text().trim();
    if (!words) return;
    props.onKeep(words, { ...(repo() ? { repo: repo() } : {}), ...(agent() ? { agent: agent() } : {}) });
    props.onClose();
  };
  keymap.bind("mod+enter", keep, { when: "always" });
  return (
    <Dialog open onClose={() => props.onClose()} title={t("web.issue.new.title")} testid="issue-new-dialog">
      <View class="gap-3">
        <TextArea
          testID="issue-new-text"
          accessibilityLabel={t("web.issue.new.words")}
          placeholder={t("web.issue.new.placeholder")}
          rows={4}
          value={text()}
          autoFocus
          onInput={text.set}
        />
        <View class="flex-row flex-wrap items-center gap-2">
          <Select
            quiet
            size="control"
            label={t("web.issue.task.repo")}
            testid="issue-new-repo"
            value={repo()}
            placeholder={t("web.issue.todo.whichRepo")}
            onChange={repo.set}
            options={[...new Set([...repos(), ...(repo() ? [repo()] : [])])].map((p) => ({ value: p, label: p }))}
          />
          <Select
            quiet
            size="control"
            label={t("web.issue.detail.helper")}
            testid="issue-new-helper"
            value={agent()}
            placeholder={t("web.issue.todo.pickForMe")}
            onChange={agent.set}
            options={agents().map((a) => ({ value: a.id, label: a.name }))}
          />
        </View>
        <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
          <Text class="mr-auto text-xs text-faint">{t("web.issue.new.keys")}</Text>
          <Button testID="issue-new-dialog-never" onPress={() => props.onClose()}>
            {t("web.base.form.never")}
          </Button>
          <Button tone="primary" testID="issue-new-keep" disabled={!text().trim()} onPress={keep}>
            {t("web.issue.new.keep")}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
