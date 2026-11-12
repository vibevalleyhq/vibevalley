import { createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { ready, useQuery } from "#/infra/query.ts";
import { Button } from "#/ui/Button.tsx";
import { Field, TextInput } from "#/ui/Field.tsx";

import { deviceGuess } from "./device";
import { afterSignIn } from "./entry";
import { signIn as signInWith } from "./login";
import { userQuery } from "./signIns";

/** Signing in from another device with the password set on the computer running VibeValley. */
export function LoginPage() {
  const status = useQuery(userQuery);
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal(deviceGuess(navigator.userAgent));
  const [signing, setSigning] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  // Unknown until it answers: the form shows, and the server says if there is no password yet.
  const noPassword = () => ready(status, undefined)?.password === false;

  const signIn = () => {
    setSigning(true);
    setProblem("");
    signInWith({ password: password(), device: name().trim() }).then(
      () => location.replace(afterSignIn(location.search)),
      (e: unknown) => {
        setProblem(reasonOf(e));
        setSigning(false);
      },
    );
  };

  return (
    <main class="flex min-h-dvh items-center justify-center bg-side px-4 text-ink">
      <form
        data-testid="login"
        class="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-page p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!signing()) signIn();
        }}
      >
        <h1 class="text-lg font-semibold">{t("web.user.login.title")}</h1>
        <p class="text-sm text-muted">{noPassword() ? t("web.user.login.noPassword") : t("web.user.login.intro")}</p>
        <Show when={!noPassword()}>
          <Field label={t("web.user.login.password")}>
            <TextInput
              data-testid="login-password"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </Field>
          <Field label={t("web.user.login.device")} hint={t("web.user.login.deviceHint")}>
            <TextInput data-testid="login-device" value={name()} onInput={(e) => setName(e.currentTarget.value)} maxlength={40} />
          </Field>
        </Show>
        <div class="flex flex-wrap items-center gap-3">
          <Show when={!noPassword()}>
            <Button tone="primary" type="submit" data-testid="login-submit" disabled={signing() || password() === ""}>
              {signing() ? t("web.user.login.signing") : t("web.user.login.submit")}
            </Button>
          </Show>
          <a href="/pair" data-testid="login-pair" class="text-sm text-accent">
            {t("web.user.login.pairInstead")}
          </a>
        </div>
        <Show when={problem()}>
          <p role="alert" class="text-sm text-berry">
            {problem()}
          </p>
        </Show>
      </form>
    </main>
  );
}
