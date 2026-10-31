// 连接到本机: lets the phones and computers on this network use this farm once paired, the owner
// saying yes to each here. Only this machine manages it: a paired device is refused the status and shown why.

import { useQueryClient } from "@tanstack/solid-query";
import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { LanPairing, LanStatus } from "@vibevalley/protocol";

import { momentText } from "@/base/format";
import { useNow } from "@/base/util";
import { api, reasonOf } from "@/infra/api";
import { ready, useQuery } from "@/infra/query";
import { type Act, createAct } from "@/ui/act";
import { Button } from "@/ui/Button";
import { Card, Quiet } from "@/ui/layout";
import { Qr } from "@/ui/Qr";
import { toast } from "@/ui/toasts";

const notes = [0, 1, 2, 3] as const;

export function LanPage() {
  const client = useQueryClient();
  // Polled: a device asking to pair shows up without a reload.
  const status = useQuery(() => ({ queryKey: ["lan"], queryFn: () => api.lan.get(), refetchInterval: 1500 }));
  const act = createAct();
  /** The status an action answers with is the newest: shown at once rather than at the next poll. */
  const keep = (status: LanStatus) => void client.setQueryData(["lan"], status);
  const s = () => ready(status, undefined);
  return (
    <div class="flex max-w-3xl flex-col gap-3">
      <Card
        title={t("web.lan.lan.section.label")}
        action={<Show when={s()}>{(s) => <span class="text-sm text-muted">{s().open ? t("web.lan.lan.open") : t("web.lan.lan.closed")}</span>}</Show>}
      >
        <Show when={s()} fallback={<Quiet>{status.error ? reasonOf(status.error) : t("web.base.form.asking")}</Quiet>}>
          {(s) => (
            <>
              <Show
                when={s().open}
                fallback={
                  <>
                    <p class="text-sm">{t("web.lan.lan.intro")}</p>
                    <div>
                      <Button
                        tone="primary"
                        data-testid="lan-allow"
                        disabled={act.busy()}
                        onClick={() => void act.run(async () => keep(await api.lan.update({ open: true })))}
                      >
                        {t("web.lan.lan.allow")}
                      </Button>
                    </div>
                  </>
                }
              >
                <div class="flex gap-3">
                  <span class="w-18 shrink-0 text-sm text-muted">{t("web.lan.lan.address")}</span>
                  <span data-testid="lan-url" class="font-mono text-sm select-all">
                    {s().url ?? "—"}
                  </span>
                </div>
                <Show
                  when={s().pairing}
                  fallback={
                    <div class="flex flex-wrap gap-2">
                      <Button
                        tone="primary"
                        data-testid="lan-add"
                        disabled={!s().url || act.busy()}
                        onClick={() => void act.run(async () => keep(await api.lan.pairing.start()))}
                      >
                        {t("web.lan.lan.add")}
                      </Button>
                      <Button
                        data-testid="lan-close"
                        disabled={act.busy()}
                        onClick={() => void act.run(async () => keep(await api.lan.update({ open: false })))}
                      >
                        {t("web.lan.lan.close")}
                      </Button>
                    </div>
                  }
                >
                  {(pairing) => <Pairing pairing={pairing()} act={act} keep={keep} />}
                </Show>
              </Show>
              <Show when={s().problem}>
                <p class="text-sm text-berry">{s().problem}</p>
              </Show>
              <ul class="flex flex-col gap-1.5 border-t border-line pt-3">
                <For each={notes}>
                  {(n) => (
                    <li class="flex gap-2.5 text-sm text-muted">
                      <span class="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                      {t(`web.lan.lan.notes.${n}`)}
                    </li>
                  )}
                </For>
              </ul>
            </>
          )}
        </Show>
      </Card>
      <Show when={s() && s()!.devices.length > 0 ? s() : undefined}>
        {(s) => (
          <Card title={t("web.lan.lan.devices")} action={<span class="text-sm text-muted">{t("web.lan.lan.deviceCount", { n: s().devices.length })}</span>}>
            <For each={s().devices}>
              {(d) => (
                <div class="flex items-center gap-2">
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm font-medium">{d.name}</span>
                    <span class="truncate text-xs text-muted">
                      {d.lastSeen != null && d.lastSeen !== 0
                        ? t("web.lan.lan.paired", { at: momentText(d.pairedAt), seen: momentText(d.lastSeen) })
                        : t("web.lan.lan.pairedNever", { at: momentText(d.pairedAt) })}
                    </span>
                  </span>
                  <Button
                    tone="danger"
                    aria-label={t("web.lan.lan.removeWhich", { name: d.name })}
                    onClick={() => void act.run(async () => keep(await api.lan.device.delete({ id: d.id })))}
                  >
                    {t("web.lan.lan.remove")}
                  </Button>
                </div>
              )}
            </For>
          </Card>
        )}
      </Show>
    </div>
  );
}

async function copy(link: string) {
  try {
    await navigator.clipboard.writeText(link);
    toast(t("web.lan.lan.copied"));
  } catch {
    toast(t("web.lan.lan.notCopied"));
  }
}

function Pairing(props: { pairing: LanPairing; act: Act; keep: (status: LanStatus) => void }) {
  // The same function for the page's life: read once, not inside each action.
  const keep = untrack(() => props.keep);
  const now = useNow(1000);
  const left = () => Math.min(999, Math.max(0, Math.ceil((props.pairing.expiresAt - now()) / 1000)));
  return (
    <Show
      when={props.pairing.asking}
      fallback={
        <div data-testid="pairing" data-left={left()} class="flex flex-wrap gap-5">
          <div data-testid="pairing-qr" class="rounded-md border border-line bg-white p-2">
            <Qr text={props.pairing.link} label={t("web.lan.lan.qr")} />
          </div>
          <div class="flex max-w-md min-w-50 flex-col gap-2">
            <p class="text-sm">{t("web.lan.lan.scan")}</p>
            <p data-testid="pairing-link" class="font-mono text-2xs break-all select-all">
              {props.pairing.link}
            </p>
            <p class="text-xs text-muted">{t("web.lan.lan.left", { s: left() })}</p>
            <div class="flex flex-wrap gap-2 pt-1">
              <Button icon="copy" onClick={() => void copy(props.pairing.link)}>
                {t("web.lan.lan.copy")}
              </Button>
              <Button disabled={props.act.busy()} onClick={() => void props.act.run(async () => keep(await api.lan.pairing.start()))}>
                {t("web.lan.lan.newCode")}
              </Button>
              <Button data-testid="pairing-stop" disabled={props.act.busy()} onClick={() => void props.act.run(async () => keep(await api.lan.pairing.stop()))}>
                {t("web.lan.lan.stop")}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      {(asking) => (
        <div class="flex flex-col gap-3">
          <p class="text-sm">{t("web.lan.lan.asking", { name: asking() })}</p>
          <div class="flex gap-2">
            <Button
              tone="primary"
              disabled={props.act.busy()}
              onClick={() => void props.act.run(async () => keep(await api.lan.pairing.answer({ allow: true })))}
            >
              {t("web.lan.lan.letIn")}
            </Button>
            <Button
              tone="danger"
              disabled={props.act.busy()}
              onClick={() => void props.act.run(async () => keep(await api.lan.pairing.answer({ allow: false })))}
            >
              {t("web.lan.lan.refuse")}
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}
