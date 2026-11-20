// VibeValley's own (docs/vibevalley-port.md § Architecture 6): wherever a page
// names a repo, a worktree or a folder, a terminal pane opens there.
import { t } from "@vibevalley/i18n";

import { hostApi } from "../../../../bridge";
import { IconButton } from "../IconButton";

export function OpenTerminal(props: { cwd: string; title?: string; testid?: string }) {
  return (
    <IconButton
      icon="terminal"
      size={14}
      testid={props.testid ?? "open-terminal"}
      label={t("web.base.openTerminal")}
      onClick={() => void hostApi.openTerminal({ cwd: props.cwd, ...(props.title !== undefined ? { title: props.title } : {}) })}
    />
  );
}
