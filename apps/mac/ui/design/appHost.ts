import { z } from "zod";

import { reasonOf } from "../infra/api";
import { saveFile } from "../infra/attachmentFile";
import { hostApi } from "../infra/bridge";
import { currentHost } from "../infra/host";
import { prefsNow, setWidth } from "../infra/state/prefs";
import { transport } from "../infra/transport";
import type { DesignHost, QrMatrix } from "./host";
import { setMotionReporter } from "./motion";
import { toast } from "./toasts";

const QrMatrixSchema = z.object({
  size: z.number().int().positive(),
  rows: z.array(z.string()),
});

export function installMotionReporter(): void {
  setMotionReporter((choice) => currentHost().motion?.(choice));
}

export function createAppDesignHost(navigate: DesignHost["navigate"]): DesignHost {
  return {
    openExternal: (url) => hostApi.openUrl(url),
    openFile: (path) => hostApi.openFile(path),
    navigate,
    saveFile: (path, name) => saveFile(path, name),
    renderQr: async (text, border): Promise<QrMatrix | undefined> => {
      const res = await transport().call("host.qr", { text, border });
      if (res.bizCode !== 0) return undefined;
      const parsed = QrMatrixSchema.safeParse(res.data);
      return parsed.success ? parsed.data : undefined;
    },
    toast,
    motion: (choice) => currentHost().motion?.(choice),
    getPrefWidth: (pane) => prefsNow().widths[pane],
    setPrefWidth: (pane, width) => setWidth(pane, width),
    formatError: reasonOf,
  };
}
