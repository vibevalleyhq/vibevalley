import * as stylex from "@stylexjs/stylex";
import { createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { Button } from "#/ui/Button.tsx";
import { Field, TextInput } from "#/ui/Field.tsx";

import { deviceGuess, pair } from "./device";

const viewStyles = stylex.create({
  askAction: { alignSelf: "flex-start" },
  pairPageMain: {
    display: "flex",
    minHeight: "100dvh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--wb-side)",
    paddingInline: "calc(var(--spacing) * 4)",
    color: "var(--wb-ink)",
  },
  pairPageForm: {
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-sm)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "calc(var(--spacing) * 5)",
  },
  pairPageH1: {
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  pairPageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  pairPageP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  pairPageP3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-berry)",
  },
});

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
      await pair(code().trim(), name().trim());
      location.replace("/");
    } catch (e) {
      setProblem(reasonOf(e));
      setAsking(false);
    }
  };

  return (
    <main {...stylex.attrs(viewStyles.pairPageMain)}>
      <form
        {...stylex.attrs(viewStyles.pairPageForm)}
        onSubmit={(e) => {
          e.preventDefault();
          if (!asking()) void ask();
        }}
      >
        <h1 {...stylex.attrs(viewStyles.pairPageH1)}>{t("web.lan.pair.title")}</h1>
        <p {...stylex.attrs(viewStyles.pairPageP)}>{t("web.lan.pair.intro")}</p>
        <Show when={!given}>
          <Field label={t("web.lan.pair.code")} hint={t("web.lan.pair.codeHint")}>
            <TextInput data-testid="pair-code" value={code()} onInput={(e) => setCode(e.currentTarget.value)} autocapitalize="characters" autocomplete="off" />
          </Field>
        </Show>
        <Field label={t("web.lan.pair.name")} hint={t("web.lan.pair.nameHint")}>
          <TextInput data-testid="pair-name" value={name()} onInput={(e) => setName(e.currentTarget.value)} maxlength={40} />
        </Field>
        <Show
          when={asking()}
          fallback={
            <Button tone="primary" type="submit" data-testid="pair-ask" disabled={!code().trim()} styles={viewStyles.askAction}>
              {t("web.lan.pair.ask")}
            </Button>
          }
        >
          <p role="status" {...stylex.attrs(viewStyles.pairPageP2)}>
            {t("web.lan.pair.waiting")}
          </p>
        </Show>
        <Show when={problem()}>
          <p role="alert" {...stylex.attrs(viewStyles.pairPageP3)}>
            {problem()}
          </p>
        </Show>
      </form>
    </main>
  );
}
