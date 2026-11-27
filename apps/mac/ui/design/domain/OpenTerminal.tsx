// VibeValley's own (docs/vibevalley-port.md § Architecture 6): wherever a page
// names a repo, a worktree or a folder, a terminal pane opens there.
import { t } from "@vibevalley/i18n";

import { useDesignHost } from "../host";
import { IconButton } from "../IconButton";

export function OpenTerminal(props: { cwd: string; title?: string; testid?: string }) {
  const designHost = useDesignHost();
  return (
    <IconButton
      icon="terminal"
      size={14}
      testid={props.testid ?? "open-terminal"}
      label={t("web.base.openTerminal")}
      onClick={() => void designHost.openTerminal({ cwd: props.cwd, ...(props.title !== undefined ? { title: props.title } : {}) })}
    />
  );
}
