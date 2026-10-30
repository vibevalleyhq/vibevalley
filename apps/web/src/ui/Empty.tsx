import type { JSX } from "@solidjs/web";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

/** A place with nothing in it yet (docs/style/design.md, 空状态): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string }) {
  return (
    <div data-testid={props.testid ?? "empty"} class="flex h-full min-h-48 items-center justify-center p-6">
      <div class="flex max-w-96 flex-col items-center gap-3 text-center text-sm text-muted">
        <Icon name={props.icon} size={48} class="text-faint" />
        <p>{props.children}</p>
        {props.action}
      </div>
    </div>
  );
}
