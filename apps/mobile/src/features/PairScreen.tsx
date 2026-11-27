import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import type { MobileLayout } from "../design/layout";
import { FieldInput, PillButton, SafeScreen, SectionCard } from "../design/ui";
import { defaultDeviceName, type RemoteSession } from "../infra/session";

export function PairScreen(props: { readonly session: RemoteSession; readonly layout: () => MobileLayout }) {
  const serverUrl = signal("");
  const pairCode = signal("");
  const deviceName = signal(defaultDeviceName());
  const isDual = computed(() => props.layout().mode === "dual_pane");
  const canSubmit = computed(() => !props.session.pairing());
  const submitLabel = computed(() => (props.session.pairing() ? t("web.remote.mobile.pairing") : t("web.remote.mobile.pairAction")));

  const submit = () => {
    if (props.session.pairing()) return;
    void props.session.pair(serverUrl(), pairCode(), deviceName());
  };

  const formCard = () => (
    <SectionCard testID="pair-form-card" class="w-full gap-4">
      <FieldInput
        testID="pair-url-input"
        label={t("web.remote.mobile.urlLabel")}
        placeholder="http://192.168.1.x:8890"
        value={serverUrl()}
        onInput={(v) => serverUrl.set(v)}
        disabled={props.session.pairing()}
      />
      <FieldInput
        testID="pair-code-input"
        label={t("web.remote.mobile.codeLabel")}
        placeholder="ABCD12"
        value={pairCode()}
        onInput={(v) => pairCode.set(v)}
        disabled={props.session.pairing()}
      />
      <FieldInput
        testID="pair-device-input"
        label={t("web.remote.mobile.deviceNameLabel")}
        placeholder={defaultDeviceName()}
        value={deviceName()}
        onInput={(v) => deviceName.set(v)}
        onSubmit={() => submit()}
        disabled={props.session.pairing()}
      />

      <If when={props.session.pairError()}>
        {(error) => (
          <View testID="pair-error" class="flex-row items-center gap-2 rounded-lg border border-berry bg-bad-soft px-3 py-2.5">
            <Icon name="warn" size={16} tone="berry" />
            <Text class="min-w-0 flex-1 text-xs font-medium text-berry">{error()}</Text>
          </View>
        )}
      </If>

      <PillButton testID="pair-submit" tone="primary" icon="link" label={submitLabel()} disabled={!canSubmit()} onPress={() => submit()} />
    </SectionCard>
  );

  return (
    <SafeScreen testID="pair-screen">
      <Scroll class="flex-1" contentClass={isDual() ? "flex-1 items-center justify-center px-8 py-10" : "gap-5 px-5 py-8"}>
        <View testID="pair-card-container" class={isDual() ? "w-full max-w-[480px] gap-5" : "w-full gap-5"}>
          <View class="items-center gap-3 pt-4">
            <View class="size-14 items-center justify-center rounded-xl border border-line bg-elevated shadow-raise">
              <Icon name="devices" size={24} tone="accent" />
            </View>
            <View class="items-center gap-1.5">
              <Text class="text-2xl font-bold text-ink">{t("web.remote.mobile.pairTitle")}</Text>
              <Text class="text-center text-sm text-muted">{t("web.remote.mobile.pairSubtitle")}</Text>
            </View>
          </View>
          {formCard()}
        </View>
      </Scroll>
    </SafeScreen>
  );
}
