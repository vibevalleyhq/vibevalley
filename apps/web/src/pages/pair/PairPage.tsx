// /pair: another device joins the farm (连接到本机). The owner's QR code opens it with the code; the device names itself
// and questions, the owner nods on the farm's computer, and the key the farm hands back is kept in a cookie.

import { createSignal, Show } from "solid-js";
import { api, reasonOf } from "../../data/api";
import { deviceGuess, keyCookie } from "../../rules/lan";
import { Button } from "../../ui/Button";
import { Field, TextInput } from "../../ui/Field";

export function PairPage() {
  const given = new URLSearchParams(location.search).get("c") ?? "";
  const [code, setCode] = createSignal(given);
  const [name, setName] = createSignal(deviceGuess(navigator.userAgent));
  const [asking, setAsking] = createSignal(false);
  const [problem, setProblem] = createSignal("");

  const ask = async () => {
    setAsking(true);
    setProblem("");
    try {
      const paired = await api.lan.pair({ body: { code: code().trim(), name: name().trim() } });
      document.cookie = keyCookie(paired.key);
      location.replace("/");
    } catch (e) {
      setProblem(reasonOf(e));
      setAsking(false);
    }
  };

  return (
    <main class="flex min-h-dvh items-center justify-center bg-side px-4 text-ink">
      <form
        class="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-page p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!asking()) void ask();
        }}
      >
        <h1 class="text-lg font-semibold">连进那台电脑</h1>
        <p class="text-sm text-muted">这台设备连进那台电脑上的 VibeValley，和主人一样看帮工、派活、在田头说话。配对要那台电脑上的主人点头。</p>
        <Show when={!given}>
          <Field label="配对码" hint="在那台电脑的「连接到本机」里点「添加设备」">
            <TextInput value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocapitalize="characters" autocomplete="off" />
          </Field>
        </Show>
        <Field label="这台设备叫" hint="主人在设备列表里看到的名字">
          <TextInput value={name()} onInput={(e) => setName(e.currentTarget.value)} maxlength={40} />
        </Field>
        <Show
          when={asking()}
          fallback={
            <Button tone="primary" type="submit" disabled={!code().trim()} class="self-start">
              请主人放行
            </Button>
          }
        >
          <p role="status" class="text-sm">
            等那台电脑上的主人点头……
          </p>
        </Show>
        <Show when={problem()}>
          <p role="alert" class="text-sm text-berry">
            {problem()}
          </p>
        </Show>
      </form>
    </main>
  );
}
