import { createSignal, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { useWorkAgents } from "@/infra/agents";
import { ready, useProjects } from "@/infra/query";
import { prefsNow } from "@/state/prefs";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Select, TextArea } from "@/ui/Field";

/** The project and helper the board is filtered to, or the list group it was opened in. */
export interface NewIssueAt {
  readonly project?: string;
  readonly agent?: string;
}

export function NewIssue(props: { at: NewIssueAt; onKeep: (words: string, where: NewIssueAt) => void; onClose: () => void }) {
  const [text, setText] = createSignal("");
  // What it was opened with, else what the last issue was given: shown as it will be used (write.ts falls back the same).
  const last = prefsNow();
  const [project, setProject] = createSignal(untrack(() => props.at.project ?? last.project));
  const [agent, setAgent] = createSignal(untrack(() => props.at.agent ?? (last.pick === "auto" ? "" : last.pick)));
  const agents = useWorkAgents(true);
  const projectList = useProjects();
  const projects = () => ready(projectList, []).map((p) => p.name);
  const keep = () => {
    const words = text().trim();
    if (!words) return;
    props.onKeep(words, { ...(project() ? { project: project() } : {}), ...(agent() ? { agent: agent() } : {}) });
    props.onClose();
  };
  return (
    <Dialog open onClose={() => props.onClose()} title={t("web.issue.new.title")} testid="issue-new-dialog">
      <form
        class="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          keep();
        }}
      >
        <TextArea
          data-testid="issue-new-text"
          aria-label={t("web.issue.new.words")}
          placeholder={t("web.issue.new.placeholder")}
          rows={4}
          value={text()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
              e.preventDefault();
              keep();
            }
          }}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Select
            quiet
            size="control"
            label={t("web.issue.task.project")}
            testid="issue-new-project"
            value={project()}
            placeholder={t("web.issue.todo.whichProject")}
            onChange={setProject}
            options={[...new Set([...projects(), ...(project() ? [project()] : [])])].map((p) => ({ value: p, label: p }))}
          />
          <Select
            quiet
            size="control"
            label={t("web.issue.detail.helper")}
            testid="issue-new-helper"
            value={agent()}
            placeholder={t("web.issue.todo.pickForMe")}
            onChange={setAgent}
            options={agents().map((a) => ({ value: a.id, label: a.name }))}
          />
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
          <span class="mr-auto text-xs text-faint">{t("web.issue.new.keys")}</span>
          <Button type="button" onClick={() => props.onClose()}>
            {t("web.base.form.never")}
          </Button>
          <Button type="submit" tone="primary" data-testid="issue-new-keep" disabled={!text().trim()}>
            {t("web.issue.new.keep")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
