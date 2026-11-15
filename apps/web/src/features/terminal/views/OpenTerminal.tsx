import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { openTerminalIn } from "#/features/terminal/model/sessions.ts";
import { currentHost } from "#/infra/host.ts";
import { useRouter } from "#/infra/router.ts";
import { Icon } from "#/ui/Icon.tsx";

export function OpenTerminal(props: { cwd: string; title?: string }) {
  const router = useRouter();
  return (
    <Show when={currentHost().terminal}>
      <button
        type="button"
        data-testid="open-terminal"
        title={t("web.terminal.openIn")}
        aria-label={t("web.terminal.openIn")}
        onClick={() => {
          openTerminalIn(props.cwd, props.title);
          router.navigate("/terminal");
        }}
        class="cursor-pointer rounded-sm p-1 hover:bg-hover"
      >
        <Icon name="terminal" size={14} />
      </button>
    </Show>
  );
}
