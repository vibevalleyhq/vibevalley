// Ported from VibeValley apps/web/src/features/lan/LanPage.tsx: letting other
// devices on the network in, and pairing one with a code. Copying goes
// through nsh's Clipboard. Not here: the pairing page a phone opens
// (PairPage), served by the LAN listener to a browser.
import { Clipboard, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { LanPairing, LanStatus } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { useNow } from "../../base/dom";
import { api, reasonOf } from "../../infra/api";
import { defineQuery, ready, retryRead, useQuery, useQueryClient } from "../../infra/query";
import { type Act, createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Card, Quiet } from "../../ui/layout";
import { Qr } from "../../ui/Qr";
import { toast } from "../../ui/toasts";

const notes = [0, 1, 2, 3] as const;

const lanQuery = defineQuery({ schema: S.LanStatus, key: () => ["lan"], fetch: (_: void, context) => api.lan.get(context), ...retryRead });

export function LanPage() {
  const client = useQueryClient();
  // Polled: a device asking to pair shows up without a reload.
  const status = useQuery(lanQuery, { interval: () => 1500 });
  const act = createAct();
  /** The status an action answers with is the newest: shown at once rather than at the next poll. */
  const keep = (status: LanStatus) => client.setData(lanQuery(), () => ({ value: status }));
  const s = () => ready(status, undefined);
  return (
    <View testID="lan" class="max-w-3xl gap-3">
      <Card
        title={t("web.lan.lan.section.label")}
        action={<If when={s()}>{(s) => <Text class="text-sm text-muted">{s().open ? t("web.lan.lan.open") : t("web.lan.lan.closed")}</Text>}</If>}
      >
        <If when={s()} else={<Quiet>{status.error() ? reasonOf(status.error()) : t("web.base.form.asking")}</Quiet>}>
          {(s) => (
            <View class="gap-4">
              <If
                when={s().open}
                else={
                  <View class="gap-4">
                    <Text class="text-sm text-ink">{t("web.lan.lan.intro")}</Text>
                    <View class="flex-row">
                      <Button
                        tone="primary"
                        testID="lan-allow"
                        disabled={act.busy()}
                        onPress={() => void act.run(async () => keep(await api.lan.update({ open: true })))}
                      >
                        {t("web.lan.lan.allow")}
                      </Button>
                    </View>
                  </View>
                }
              >
                <View class="gap-4">
                  <View class="flex-row gap-3">
                    <Text class="w-18 shrink-0 text-sm text-muted">{t("web.lan.lan.address")}</Text>
                    <Text testID="lan-url" class="select-text font-mono text-sm text-ink">
                      {s().url ?? "—"}
                    </Text>
                  </View>
                  <If
                    when={s().pairing}
                    else={
                      <View class="flex-row flex-wrap gap-2">
                        <Button
                          tone="primary"
                          testID="lan-add"
                          disabled={!s().url || act.busy()}
                          onPress={() => void act.run(async () => keep(await api.lan.pairing.start()))}
                        >
                          {t("web.lan.lan.add")}
                        </Button>
                        <Button testID="lan-close" disabled={act.busy()} onPress={() => void act.run(async () => keep(await api.lan.update({ open: false })))}>
                          {t("web.lan.lan.close")}
                        </Button>
                      </View>
                    }
                  >
                    {(pairing) => <Pairing pairing={pairing()} act={act} keep={keep} />}
                  </If>
                </View>
              </If>
              <If when={s().problem}>
                <Text class="text-sm text-berry">{s().problem}</Text>
              </If>
              <View class="gap-1.5 border-t border-line pt-3">
                <Each of={notes}>
                  {(n) => (
                    <View class="flex-row gap-2.5">
                      <View class="mt-2 size-1 shrink-0 rounded-full bg-faint" />
                      <Text class="min-w-0 flex-1 text-sm text-muted">{t(`web.lan.lan.notes.${n()}`)}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          )}
        </If>
      </Card>
    </View>
  );
}

async function copy(link: string) {
  try {
    await Clipboard.writeText(link);
    toast(t("web.lan.lan.copied"));
  } catch {
    toast(t("web.lan.lan.notCopied"));
  }
}

function Pairing(props: { pairing: LanPairing; act: Act; keep: (status: LanStatus) => void }) {
  // The same function for the page's life: read once, not inside each action.
  const keep = untracked(() => props.keep);
  const now = useNow(1000);
  const left = () => Math.min(999, Math.max(0, Math.ceil((props.pairing.expiresAt - now()) / 1000)));
  return (
    <If
      when={props.pairing.asking}
      else={
        <View testID="pairing" class="flex-row flex-wrap gap-5">
          <View testID="pairing-qr" class="rounded-md border border-line p-2" style={{ backgroundColor: "#ffffff" }}>
            <Qr text={props.pairing.link} label={t("web.lan.lan.qr")} />
          </View>
          <View class="min-w-50 max-w-md flex-1 gap-2">
            <Text class="text-sm text-ink">{t("web.lan.lan.scan")}</Text>
            <Text testID="pairing-link" class="select-text font-mono text-2xs text-ink">
              {props.pairing.link}
            </Text>
            <Text class="text-xs text-muted">{t("web.lan.lan.left", { s: left() })}</Text>
            <View class="flex-row flex-wrap gap-2 pt-1">
              <Button icon="copy" testID="pairing-copy" onPress={() => void copy(props.pairing.link)}>
                {t("web.lan.lan.copy")}
              </Button>
              <Button disabled={props.act.busy()} onPress={() => void props.act.run(async () => keep(await api.lan.pairing.start()))}>
                {t("web.lan.lan.newCode")}
              </Button>
              <Button testID="pairing-stop" disabled={props.act.busy()} onPress={() => void props.act.run(async () => keep(await api.lan.pairing.stop()))}>
                {t("web.lan.lan.stop")}
              </Button>
            </View>
          </View>
        </View>
      }
    >
      {(asking) => (
        <View class="gap-3">
          <Text class="text-sm text-ink">{t("web.lan.lan.asking", { name: asking() })}</Text>
          <View class="flex-row gap-2">
            <Button
              tone="primary"
              testID="pairing-allow"
              disabled={props.act.busy()}
              onPress={() => void props.act.run(async () => keep(await api.lan.pairing.answer({ allow: true })))}
            >
              {t("web.lan.lan.letIn")}
            </Button>
            <Button
              tone="danger"
              disabled={props.act.busy()}
              onPress={() => void props.act.run(async () => keep(await api.lan.pairing.answer({ allow: false })))}
            >
              {t("web.lan.lan.refuse")}
            </Button>
          </View>
        </View>
      )}
    </If>
  );
}
