import * as stylex from "@stylexjs/stylex";
import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { LanPairing, LanStatus } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { useNow } from "#/base/dom.tsx";
import { momentText } from "#/base/format.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { defineQuery, retryRead, useQueryClient, ready, useQuery } from "#/infra/query.ts";
import { type Act, createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { Qr } from "#/ui/Qr.tsx";
import { toast } from "#/ui/toasts.ts";

const variantStyles = stylex.create({
  lanPageSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
});

const viewStyles = stylex.create({
  lanPageDiv: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  lanPageSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  lanPageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  lanPageDiv2: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
  },
  lanPageSpan2: {
    width: "calc(var(--spacing) * 18)",
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  lanPageDiv3: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  lanPageP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-berry)",
  },
  lanPageUl: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingTop: "calc(var(--spacing) * 3)",
  },
  lanPageLi: {
    display: "flex",
    gap: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  lanPageSpan3: {
    marginTop: "calc(var(--spacing) * 2)",
    width: "var(--spacing)",
    height: "var(--spacing)",
    flexShrink: "0",
    borderRadius: "2147483647px",
    backgroundColor: "var(--wb-faint)",
  },
  lanPageDiv4: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  lanPageSpan4: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  lanPageSpan5: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  pairing: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 5)",
  },
  pairingQr: {
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--color-white)",
    padding: "calc(var(--spacing) * 2)",
  },
  pairingDiv: {
    display: "flex",
    maxWidth: "var(--container-md)",
    minWidth: "calc(var(--spacing) * 50)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  pairingP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  pairingDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
    paddingTop: "var(--spacing)",
  },
  pairingDiv3: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  pairingDiv4: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
});

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
    <div {...stylex.attrs(viewStyles.lanPageDiv)}>
      <Card
        title={t("web.lan.lan.section.label")}
        action={
          <Show when={s()}>{(s) => <span {...stylex.attrs(viewStyles.lanPageSpan)}>{s().open ? t("web.lan.lan.open") : t("web.lan.lan.closed")}</span>}</Show>
        }
      >
        <Show when={s()} fallback={<Quiet>{status.error() ? reasonOf(status.error()) : t("web.base.form.asking")}</Quiet>}>
          {(s) => (
            <>
              <Show
                when={s().open}
                fallback={
                  <>
                    <p {...stylex.attrs(viewStyles.lanPageP)}>{t("web.lan.lan.intro")}</p>
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
                <div {...stylex.attrs(viewStyles.lanPageDiv2)}>
                  <span {...stylex.attrs(viewStyles.lanPageSpan2)}>{t("web.lan.lan.address")}</span>
                  <span data-testid="lan-url" class="font-mono text-sm select-all">
                    {s().url ?? "—"}
                  </span>
                </div>
                <Show
                  when={s().pairing}
                  fallback={
                    <div {...stylex.attrs(viewStyles.lanPageDiv3)}>
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
                <p {...stylex.attrs(viewStyles.lanPageP2)}>{s().problem}</p>
              </Show>
              <ul {...stylex.attrs(viewStyles.lanPageUl)}>
                <For each={notes}>
                  {(n) => (
                    <li {...stylex.attrs(viewStyles.lanPageLi)}>
                      <span {...stylex.attrs(viewStyles.lanPageSpan3)} aria-hidden="true" />
                      {t(`web.lan.lan.notes.${n}`)}
                    </li>
                  )}
                </For>
              </ul>
            </>
          )}
        </Show>
      </Card>
      <Show when={s() && (s()?.devices.length ?? 0) > 0 ? s() : undefined}>
        {(s) => (
          <Card
            title={t("web.lan.lan.devices")}
            action={<span {...stylex.attrs(viewStyles.lanPageSpan)}>{t("web.lan.lan.deviceCount", { n: s().devices.length })}</span>}
          >
            <For each={s().devices}>
              {(d) => (
                <div {...stylex.attrs(viewStyles.lanPageDiv4)}>
                  <span {...stylex.attrs(variantStyles.lanPageSpan)}>
                    <span {...stylex.attrs(viewStyles.lanPageSpan4)}>{d.name}</span>
                    <span {...stylex.attrs(viewStyles.lanPageSpan5)}>
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
        <div data-testid="pairing" data-left={left()} {...stylex.attrs(viewStyles.pairing)}>
          <div data-testid="pairing-qr" {...stylex.attrs(viewStyles.pairingQr)}>
            <Qr text={props.pairing.link} label={t("web.lan.lan.qr")} />
          </div>
          <div {...stylex.attrs(viewStyles.pairingDiv)}>
            <p {...stylex.attrs(viewStyles.lanPageP)}>{t("web.lan.lan.scan")}</p>
            <p data-testid="pairing-link" class="font-mono text-2xs break-all select-all">
              {props.pairing.link}
            </p>
            <p {...stylex.attrs(viewStyles.pairingP)}>{t("web.lan.lan.left", { s: left() })}</p>
            <div {...stylex.attrs(viewStyles.pairingDiv2)}>
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
        <div {...stylex.attrs(viewStyles.pairingDiv3)}>
          <p {...stylex.attrs(viewStyles.lanPageP)}>{t("web.lan.lan.asking", { name: asking() })}</p>
          <div {...stylex.attrs(viewStyles.pairingDiv4)}>
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
