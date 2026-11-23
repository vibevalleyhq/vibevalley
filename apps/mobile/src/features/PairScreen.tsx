import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { FieldInput, PillButton, SafeScreen, SectionCard } from "../design/ui";
import { defaultDeviceName, type RemoteSession } from "../infra/session";

export function PairScreen(props: { readonly session: RemoteSession }) {
  const serverUrl = signal("");
  const pairCode = signal("");
  const deviceName = signal(defaultDeviceName());

  const submit = () => {
    if (props.session.pairing()) return;
    void props.session.pair(serverUrl(), pairCode(), deviceName());
  };

  return (
    <SafeScreen testID="pair-screen">
      <Scroll class="flex-1" contentClass="gap-5 px-5 py-8">
        <View class="items-center gap-3 pt-4">
          <View class="size-14 items-center justify-center rounded-xl border border-line bg-elevated shadow-raise">
            <Icon name="devices" size={24} tone="accent" />
          </View>
          <View class="items-center gap-1.5">
            <Text class="text-2xl font-bold text-ink">{t("web.remote.mobile.pairTitle")}</Text>
            <Text class="text-center text-sm text-muted">{t("web.remote.mobile.pairSubtitle")}</Text>
          </View>
        </View>

        <SectionCard class="gap-4">
          <FieldInput
            testID="pair-url-input"
            label={t("web.remote.mobile.urlLabel")}
            placeholder="http://100.x.y.z:8890"
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

          <PillButton
            testID="pair-submit"
            tone="primary"
            icon="link"
            label={props.session.pairing() ? t("web.remote.mobile.pairing") : t("web.remote.mobile.pairAction")}
            disabled={props.session.pairing()}
            onPress={() => submit()}
          />
        </SectionCard>
      </Scroll>
    </SafeScreen>
  );
}
