// Whether MOSS Live takes the key: the one typed in, or the saved one. The server attaches a session and closes it
// (voice.moss.verify); the answer is a mark, its reason on hover.

import { t } from "@vibevalley/i18n";

import { createSignal, Match, Switch } from "solid-js";
import { api, reasonOf } from "@/base/api";
import { Icon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { Tip } from "@/ui/Tip";

export type MossVerifyResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

const said = (r: MossVerifyResult) => (r.ok ? t("web.voice.voice.moss.ok") : r.why);

export function MossVerify(props: { typed: () => string }) {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<MossVerifyResult>();
  const check = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const key = props.typed().trim();
      const r = await api.voice.moss.verify(key ? { key } : {});
      setResult(r.problem ? { ok: false, why: r.problem } : { ok: true });
    } catch (e) {
      setResult({ ok: false, why: reasonOf(e) });
    } finally {
      setBusy(false);
    }
  };
  return <MossVerifyView busy={busy()} result={result()} onCheck={() => void check()} />;
}

/** The check as it looks: nothing yet, asking, or the answer as a mark with its reason on hover. */
export function MossVerifyView(props: { busy: boolean; result?: MossVerifyResult | undefined; onCheck: () => void }) {
  return (
    <div class="flex items-center gap-1.5">
      <IconButton icon="plug" label={t("web.voice.voice.moss.verify")} disabled={props.busy} onClick={() => props.onCheck()} />
      <Switch>
        <Match when={props.busy}>
          <Tip text={t("web.voice.voice.moss.checking")}>
            <span role="status" aria-label={t("web.voice.voice.moss.checking")}>
              <Icon name="wait" size={14} />
            </span>
          </Tip>
        </Match>
        <Match when={props.result}>
          {(r) => (
            <Tip text={said(r())}>
              <span role="status" aria-label={said(r())}>
                <Icon name={r().ok ? "check" : "warn"} size={14} />
              </span>
            </Tip>
          )}
        </Match>
      </Switch>
    </div>
  );
}
