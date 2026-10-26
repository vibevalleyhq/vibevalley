// 连接到本机: lets the phones and computers on this network use this farm once paired, the owner
// saying yes to each here. Only this machine manages it: a paired device is refused the status and shown why.

import { settingsWording } from "./words";
import { For, Show } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { LanPairing, LanStatus } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { momentText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { useNow } from "../../app/util";
import { ready, useQuery } from "../../data/query";
import { Button } from "../../ui/Button";
import { Qr } from "../../ui/Qr";
import { Card, Quiet } from "../kit";

const notes = settingsWording().lan.notes;

type Act = (call: () => Promise<LanStatus>) => Promise<void>;

export function LanPage() {
  const client = useQueryClient();
  // Polled: a device asking to pair shows up without a reload.
  const status = useQuery(() => ({ queryKey: ["lan"], queryFn: () => api.lan.status(), refetchInterval: 1500 }));
  const act: Act = async (call) => {
    try {
      client.setQueryData(["lan"], await call());
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const s = () => ready(status, undefined);
  return (
    <div class="flex max-w-3xl flex-col gap-3">
      <Card
        title={settingsWording().sections.lan.label}
        action={<Show when={s()}>{(s) => <span class="text-sm text-muted">{s().open ? settingsWording().lan.open : settingsWording().lan.closed}</span>}</Show>}
      >
        <Show when={s()} fallback={<Quiet>{status.error ? reasonOf(status.error) : settingsWording().asking}</Quiet>}>
          {(s) => (
            <>
              <Show
                when={s().open}
                fallback={
                  <>
                    <p class="text-sm">{settingsWording().lan.intro}</p>
                    <div>
                      <Button tone="primary" onClick={() => void act(() => api.lan.update({ body: { open: true } }))}>
                        {settingsWording().lan.allow}
                      </Button>
                    </div>
                  </>
                }
              >
                <div class="flex gap-3">
                  <span class="w-18 shrink-0 text-sm text-muted">{settingsWording().lan.address}</span>
                  <span class="font-mono text-sm select-all">{s().url ?? "—"}</span>
                </div>
                <Show
                  when={s().pairing}
                  fallback={
                    <div class="flex flex-wrap gap-2">
                      <Button tone="primary" disabled={!s().url} onClick={() => void act(() => api.lan.startPairing())}>
                        {settingsWording().lan.add}
                      </Button>
                      <Button onClick={() => void act(() => api.lan.update({ body: { open: false } }))}>{settingsWording().lan.close}</Button>
                    </div>
                  }
                >
                  {(pairing) => <Pairing pairing={pairing()} act={act} />}
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
                      {n}
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
          <Card title={settingsWording().lan.devices} action={<span class="text-sm text-muted">{settingsWording().lan.deviceCount(s().devices.length)}</span>}>
            <For each={s().devices}>
              {(d) => (
                <div class="flex items-center gap-2">
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm font-medium">{d.name}</span>
                    <span class="truncate text-xs text-muted">
                      {settingsWording().lan.paired(momentText(d.pairedAt), d.lastSeen ? momentText(d.lastSeen) : undefined)}
                    </span>
                  </span>
                  <Button
                    tone="danger"
                    aria-label={settingsWording().lan.removeWhich(d.name)}
                    onClick={() => void act(() => api.lan.deleteDevice({ id: d.id }))}
                  >
                    {settingsWording().lan.remove}
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
    toast(settingsWording().lan.copied);
  } catch {
    toast(settingsWording().lan.notCopied);
  }
}

function Pairing(props: { pairing: LanPairing; act: Act }) {
  const now = useNow(1000);
  const left = () => Math.min(999, Math.max(0, Math.ceil((props.pairing.expiresAt - now()) / 1000)));
  return (
    <Show
      when={props.pairing.asking}
      fallback={
        <div class="flex flex-wrap gap-5">
          <div class="rounded-md border border-line bg-white p-2">
            <Qr text={props.pairing.link} label={settingsWording().lan.qr} />
          </div>
          <div class="flex max-w-md min-w-50 flex-col gap-2">
            <p class="text-sm">{settingsWording().lan.scan}</p>
            <p class="font-mono text-[11.5px] break-all select-all">{props.pairing.link}</p>
            <p class="text-xs text-muted">{settingsWording().lan.left(left())}</p>
            <div class="flex flex-wrap gap-2 pt-1">
              <Button icon="button-copy" onClick={() => void copy(props.pairing.link)}>
                {settingsWording().lan.copy}
              </Button>
              <Button onClick={() => void props.act(() => api.lan.startPairing())}>{settingsWording().connectors.newCode}</Button>
              <Button onClick={() => void props.act(() => api.lan.stopPairing())}>{settingsWording().lan.stop}</Button>
            </div>
          </div>
        </div>
      }
    >
      {(asking) => (
        <div class="flex flex-col gap-3">
          <p class="text-sm">{settingsWording().lan.asking(asking())}</p>
          <div class="flex gap-2">
            <Button tone="primary" onClick={() => void props.act(() => api.lan.answerPairing({ body: { allow: true } }))}>
              {settingsWording().lan.letIn}
            </Button>
            <Button tone="danger" onClick={() => void props.act(() => api.lan.answerPairing({ body: { allow: false } }))}>
              {settingsWording().lan.refuse}
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}
