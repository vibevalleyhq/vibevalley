import type { JSX } from "nsh";
import { z } from "zod";

import { setModalOverlayReporter } from "../design/Dialog";
import { DesignHostProvider, registerDesignCoreBridge, type DesignHost, type QrMatrix } from "../design/host";
import { setMotionReporter } from "../design/motion";
import { toast } from "../design/toasts";
import { setDefaultActReporter } from "../infra/act";
import { api, reasonOf } from "../infra/api";
import { attachmentData } from "../infra/attachment";
import { importLocalAttachment, openAttachment, saveFile, useAttachmentFile } from "../infra/attachmentFile";
import { matches } from "../infra/base/search";
import { act, hostApi } from "../infra/bridge";
import { currentHost } from "../infra/host";
import { readHostParams } from "../infra/hostParams";
import { defineQuery, ready, useAgents, useQuery, useRuntimes, useSettings } from "../infra/query";
import { fixOf } from "../infra/readiness";
import { coreBridge, richNative } from "../infra/rich";
import { useRouter } from "../infra/router";
import { prefsNow, setWidth } from "../infra/state/prefs";
import { transport } from "../infra/transport";
import { isVdpEnabled, useVdpNode } from "../infra/vdpProbe";

// Wire module-level bridges once when the desktop composition root loads.
setDefaultActReporter((reason) => toast(reason, "bad"));
registerDesignCoreBridge(coreBridge);

const QrMatrixSchema = z.object({
  size: z.number().int().positive(),
  rows: z.array(z.string()),
});

const AssetsDir = z.object({ path: z.string() });

const assetsDirQuery = defineQuery({
  schema: AssetsDir,
  key: () => ["assets-dir"],
  fetch: async (): Promise<unknown> => {
    const envelope = await transport().call("host.assetsDir", {});
    if (envelope.bizCode !== 0) throw new Error(envelope.message);
    return envelope.data;
  },
  staleTime: Infinity,
  retry: 0,
});

function useHostAssetsDir(): () => string | undefined {
  const query = useQuery(assetsDirQuery);
  const paramDir = readHostParams().assetsDir;
  return () => ready(query, undefined)?.path ?? paramDir;
}

export function installMotionReporter(): void {
  setMotionReporter((choice) => currentHost().motion?.(choice));
}

function installModalOverlayReporter(): void {
  setModalOverlayReporter((active) => {
    if (readHostParams().globalShell) act({ type: "global_modal", active });
  });
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
    rich: richNative,
    useAttachmentFile,
    openAttachment,
    uploadAttachmentBlob: async (file, fallbackName) => {
      const data = await attachmentData(file);
      const name = "name" in file && typeof file.name === "string" && file.name !== "" ? file.name : fallbackName;
      return api.attachment.create({
        name,
        type: file.type || "image/png",
        data,
      });
    },
    importLocalAttachment,
    useAssetsDir: useHostAssetsDir,
    openTerminal: (req) => hostApi.openTerminal(req),
    isProbeEnabled: isVdpEnabled,
    useProbe: useVdpNode,
    useAgents: () => {
      const agents = useAgents();
      return () => ready(agents, []);
    },
    useRuntimes: () => {
      const runtimes = useRuntimes();
      return () => ready(runtimes, []);
    },
    useSettings: () => {
      const settings = useSettings();
      return () => ready(settings, undefined);
    },
    readinessFix: fixOf,
    matchesSearch: matches,
  };
}

export function WorkbenchDesignHost(props: { children: JSX.Element }) {
  installMotionReporter();
  installModalOverlayReporter();
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
