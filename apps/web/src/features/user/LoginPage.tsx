import * as stylex from "@stylexjs/stylex";
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

const viewStyles = stylex.create({
  main: {
    display: "flex",
    minHeight: "100dvh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-side)",
    paddingInline: "calc(var(--spacing) * 4)",
    color: "var(--color-ink)",
  },
  form: {
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-sm)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 5)",
  },
  title: {
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  note: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  problem: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  link: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-accent)",
  },
});

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
    <main {...stylex.attrs(viewStyles.main)}>
      <form
        data-testid="login"
        {...stylex.attrs(viewStyles.form)}
        onSubmit={(e) => {
          e.preventDefault();
          if (!signing()) signIn();
        }}
      >
        <h1 {...stylex.attrs(viewStyles.title)}>{t("web.user.login.title")}</h1>
        <p {...stylex.attrs(viewStyles.note)}>{noPassword() ? t("web.user.login.noPassword") : t("web.user.login.intro")}</p>
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
        <div {...stylex.attrs(viewStyles.actions)}>
          <Show when={!noPassword()}>
            <Button tone="primary" type="submit" data-testid="login-submit" disabled={signing() || password() === ""}>
              {signing() ? t("web.user.login.signing") : t("web.user.login.submit")}
            </Button>
          </Show>
          <a href="/pair" data-testid="login-pair" {...stylex.attrs(viewStyles.link)}>
            {t("web.user.login.pairInstead")}
          </a>
        </div>
        <Show when={problem()}>
          <p role="alert" {...stylex.attrs(viewStyles.problem)}>
            {problem()}
          </p>
        </Show>
      </form>
    </main>
  );
}
