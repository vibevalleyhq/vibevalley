import { effect, keymap, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, HtmlAnchor } from "@vibevalley/protocol";

import { createEffect } from "../../../solid";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { toast } from "../../ui/toasts";
import { artifactHref } from "./ArtifactCard";
import type { Frame } from "./frame";

/** One version's frame: made again when another version is shown, so the words picked are always this version's. */
export function PageWords(props: { artifact: Artifact; version: number; frame: Frame }) {
  const queries = useQueryClient();
  const router = useRouter();
  const picked = signal<HtmlAnchor | undefined>(undefined);
  const text = signal("");
  const focused = signal(false);
  createEffect(
    () => props.frame.picked(),
    (anchor) => {
      if (!anchor) return;
      picked.set(anchor);
      text.set(anchor.exact.trim());
    },
  );
  const latest = () => props.version === props.artifact.version;
  const act = createAct();
  const save = async () => {
    const anchor = picked();
    const words = text();
    if (!anchor || act.busy()) return;
    const { id } = props.artifact;
    const version = props.version;
    const made = await act.run(() => api.artifact.html.edit({ id, version, anchor, text: words }));
    if (!made) return;
    picked.set(undefined);
    void queries.invalidate({ prefix: ["artifacts"] });
    router.navigate(artifactHref(id), { replace: true });
    toast(t("web.artifact.edit.saved", { version: made.version }));
  };
  effect(() => {
    if (!focused()) return;
    return keymap.bind({ "mod+enter": () => void save(), escape: () => picked.set(undefined) }, { when: "always" });
  });
  return (
    <If when={picked()}>
      <View testID="artifact-words" class="gap-1.5">
        <Text class="text-xs font-semibold text-muted">{t("web.artifact.edit.title")}</Text>
        <If when={latest() ? picked() : undefined} else={<Text class="text-xs text-faint">{t("web.artifact.edit.older")}</Text>}>
          {(p) => (
            <>
              <View testID="artifact-words-quote" class="border-l-2 border-wheat pl-2">
                <Text class="line-clamp-3 text-xs text-muted">{p().exact.trim()}</Text>
              </View>
              <TextArea
                testID="artifact-words-text"
                accessibilityLabel={t("web.artifact.edit.to")}
                rows={3}
                value={text()}
                onInput={(v) => text.set(v)}
                onFocus={() => focused.set(true)}
                onBlur={() => focused.set(false)}
              />
              <View class="flex-row items-center justify-end gap-2">
                <Button onPress={() => picked.set(undefined)}>{t("web.base.form.never")}</Button>
                <Button tone="primary" testID="artifact-words-save" disabled={act.busy()} onPress={() => void save()}>
                  {t("web.artifact.edit.save")}
                </Button>
              </View>
            </>
          )}
        </If>
      </View>
    </If>
  );
}
