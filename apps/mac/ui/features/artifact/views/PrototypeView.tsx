import { computed, signal, Text, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { IconButton } from "../../../design/IconButton";
import { Segmented } from "../../../design/Segmented";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { reasonOf } from "../../../infra/api";
import { Keyed } from "../../../infra/base/dom";
import { currentHost } from "../../../infra/host";
import { buildPrototypeDocument } from "../frame";
import { InstallAppletModal, useInstalledApplets } from "../InstallAppletModal";

type PrototypeViewport = "full" | "tablet" | "mobile";

export function PrototypeView(props: {
  readonly artifact: Artifact;
  readonly files: ReadonlyMap<string, string>;
  readonly compact?: boolean | undefined;
  readonly covered?: boolean | undefined;
  readonly onOpenChat?: (() => void) | undefined;
}) {
  const htmlFiles = computed(() => {
    const keys = [...props.files.keys()].filter((p) => /\.(?:html|htm)$/iu.test(p)).toSorted((a, b) => a.localeCompare(b));
    const idx = keys.indexOf("structure/index.html");
    if (idx > 0) {
      keys.splice(idx, 1);
      keys.unshift("structure/index.html");
    }
    return keys;
  });

  const chosenEntry = signal<string | undefined>(undefined);
  const activeEntry = computed(() => {
    const picked = chosenEntry();
    const list = htmlFiles();
    if (picked !== undefined && list.includes(picked)) return picked;
    return list.at(0);
  });

  const viewport = signal<PrototypeViewport>("full");
  const reloadKey = signal(0);
  const appletOpen = signal(false);

  const installedApplets = useInstalledApplets();
  const installedApp = computed(() => installedApplets().find((a) => a.artifactId === props.artifact.id && a.installed));

  const prototypeHtml = computed(() => buildPrototypeDocument(props.files, activeEntry()));

  const frameWidth = () => {
    const mode = viewport();
    if (mode === "mobile") return 390;
    if (mode === "tablet") return 768;
    return undefined;
  };

  const launchInstalled = () => {
    const applet = currentHost().applet;
    const info = installedApp();
    if (!applet || !info) return;
    void applet.open(props.artifact.id).then(
      () => toast(t("web.artifact.applet.openedToast", { name: info.appName })),
      (e: unknown) => toast(reasonOf(e), "bad"),
    );
  };

  const webViewCovered = () => props.covered === true || appletOpen();

  return (
    <View testID="artifact-prototype-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <If when={props.compact !== true}>
        <View
          testID="prototype-preview-bar"
          class="min-h-9 shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-line bg-side px-3 py-1"
        >
          <View class="flex-row flex-wrap items-center gap-2">
            <Segmented
              testid="prototype-viewport"
              label={t("web.artifact.prototype.viewportLabel")}
              value={viewport()}
              onChange={(v) => viewport.set(v)}
              options={[
                { value: "full" as const, label: t("web.artifact.prototype.viewportFull") },
                { value: "tablet" as const, label: t("web.artifact.prototype.viewportTablet") },
                { value: "mobile" as const, label: t("web.artifact.prototype.viewportMobile") },
              ]}
            />
            <If when={htmlFiles().length > 1}>
              <View class="flex-row flex-wrap items-center gap-1">
                <Each of={htmlFiles()} key={(p) => p}>
                  {(p) => {
                    const selected = () => activeEntry() === p();
                    const shortName = () => p().replace(/^structure\//u, "");
                    return (
                      <Button size="compact" tone={selected() ? "primary" : "plain"} onPress={() => chosenEntry.set(p())}>
                        {shortName()}
                      </Button>
                    );
                  }}
                </Each>
              </View>
            </If>
          </View>

          <View class="flex-row items-center gap-1.5">
            <If when={frameWidth()}>{(w) => <Text class="font-mono text-2xs text-faint tabular-nums">{`${w()}px`}</Text>}</If>
            <IconButton
              icon="refresh"
              size={14}
              label={t("web.artifact.prototype.reload")}
              testid="prototype-reload"
              onClick={() => reloadKey.set(reloadKey() + 1)}
            />
            <If when={props.onOpenChat}>
              <Button size="compact" icon="chat" testID="prototype-iterate-ai" onPress={() => props.onOpenChat?.()}>
                {t("web.artifact.prototype.iterateAi")}
              </Button>
            </If>
            <If when={currentHost().applet !== undefined}>
              <View class="flex-row items-center gap-1">
                <If when={installedApp()}>
                  <Button
                    size="compact"
                    icon="open"
                    testID="prototype-open-app"
                    tooltip={<Bubble text={t("web.artifact.applet.openApp")} />}
                    onPress={launchInstalled}
                  >
                    {t("web.artifact.prototype.openApp")}
                  </Button>
                </If>
                <Button
                  size="compact"
                  tone={installedApp() ? "plain" : "primary"}
                  icon="devices"
                  testID="prototype-install-app"
                  onPress={() => appletOpen.set(true)}
                >
                  {installedApp() ? t("web.artifact.applet.manageApp") : t("web.artifact.prototype.installApp")}
                </Button>
              </View>
            </If>
          </View>
        </View>
      </If>

      <View class={`min-h-0 min-w-0 flex-1 ${frameWidth() !== undefined ? "items-center bg-side p-4" : ""}`}>
        <View
          class={
            frameWidth() !== undefined ? "min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-page shadow-raise" : "min-h-0 w-full flex-1 bg-page"
          }
          style={frameWidth() !== undefined ? { width: frameWidth(), maxWidth: "100%" } : undefined}
        >
          <Keyed key={`${activeEntry() ?? "default"}:${reloadKey()}`}>
            {() => (
              /* Strictly sandboxed WebView: incognito + strict CSP via buildPrototypeDocument (never shares host origin). */
              <WebView
                testID="artifact-prototype-webview"
                accessibilityLabel={props.artifact.title}
                html={prototypeHtml()}
                incognito
                class="min-h-0 w-full flex-1 bg-page"
                style={webViewCovered() ? { opacity: 0 } : undefined}
              />
            )}
          </Keyed>
        </View>
      </View>

      <InstallAppletModal open={appletOpen()} artifact={props.artifact} onClose={() => appletOpen.set(false)} />
    </View>
  );
}
