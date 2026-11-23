import type { JSX } from "nsh";
import { z } from "zod";

import { DesignHostProvider, type DesignHost, type QrMatrix } from "../design/host";
import { setMotionReporter } from "../design/motion";
import { toast } from "../design/toasts";
import { reasonOf } from "../infra/api";
import { saveFile } from "../infra/attachmentFile";
import { act, hostApi } from "../infra/bridge";
import { currentHost } from "../infra/host";
import { useRouter } from "../infra/router";
import { prefsNow, setWidth } from "../infra/state/prefs";
import { transport } from "../infra/transport";

const QrMatrixSchema = z.object({
  size: z.number().int().positive(),
  rows: z.array(z.string()),
});

export function installMotionReporter(): void {
  setMotionReporter((choice) => currentHost().motion?.(choice));
}

function createAppDesignHost(navigate: DesignHost["navigate"]): DesignHost {
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

export function WorkbenchDesignHost(props: { children: JSX.Element }) {
  installMotionReporter();
  const router = useRouter();
  const designHost = createAppDesignHost((path, options) => router.navigate(path, options));
  return <DesignHostProvider host={designHost}>{props.children}</DesignHostProvider>;
}

export function HostDesignProvider(props: { navigate?: DesignHost["navigate"]; children: JSX.Element }) {
  installMotionReporter();
  const designHost = createAppDesignHost((path, options) => {
    if (props.navigate) props.navigate(path, options);
    else act({ type: "open_route", path });
  });
  return <DesignHostProvider host={designHost}>{props.children}</DesignHostProvider>;
}
