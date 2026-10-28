import { t } from "@vibevalley/i18n";
// One artifact, at one version: a page in its own sandbox (docs/subsystems/artifact.md, 安全), or Markdown drawn here;
// beside it, its versions, each where it was said, and a reply to the one shown, which reaches its maker.

import { type Artifact, type ArtifactVersion, artifactPath } from "@vibevalley/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import { api, reasonOf } from "../../base/api";
import { ago } from "../../base/format";
import { queries, ready } from "../../base/query";
import { useRouter, useSearch } from "../../base/router";
import { useNow } from "../../base/util";
import { A } from "../../ui/A";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { TextArea } from "../../ui/Field";
import { OutLink } from "../../ui/IconButton";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Quiet } from "../../ui/layout";
import { Tag } from "../../ui/Tag";
import { toast } from "../../ui/toasts";
import { kindLabel } from "./ArtifactCard";
import { artifactHref, useArtifact, useArtifactText } from "./data";

/** What a page in the frame may do: run its scripts and open links in a tab of their own. Never allow-same-origin: it
 * would be the farm's own page. The server's header says the same (artifact/rules.ts). */
const sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

const messageHref = (v: ArtifactVersion) => (v.number !== undefined ? `/chat/${v.channel}?m=${v.number}` : `/chat/${v.channel}`);

export function ArtifactPage(props: { id: string }) {
  const found = useArtifact(() => props.id);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <div class="p-6">
          <Quiet>{found.isError ? t("web.artifact.page.gone") : ""}</Quiet>
        </div>
      }
    >
      {(a) => <Shown artifact={a()} />}
    </Show>
  );
}

function Shown(props: { artifact: Artifact }) {
  const search = useSearch();
  const router = useRouter();
  const now = useNow();
  const asked = () => Number(search().get("v"));
  const version = createMemo(() => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1)!);
  const text = useArtifactText(
    () => props.artifact.id,
    () => version().version,
    () => props.artifact.kind === "markdown",
  );
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
  const remove = async () => {
    try {
      await api.artifact.delete({ id: props.artifact.id });
      void queries.invalidateQueries({ queryKey: ["artifacts"] });
      toast(t("web.artifact.page.deleted", { title: props.artifact.title }));
      router.navigate(messageHref(props.artifact.versions[0]!));
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <div data-testid="artifact" data-key={props.artifact.id} data-version={version().version} class="flex h-full min-h-0 flex-col gap-3 p-4 lg:flex-row">
      <section class="flex min-h-[70vh] min-w-0 flex-1 flex-col gap-3 lg:min-h-0">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 class="min-w-0 truncate text-xl font-semibold">{props.artifact.title}</h2>
          <Tag label={kindLabel[props.artifact.kind]} tone="wait" />
          <span class="text-xs text-muted">
            {t("web.artifact.page.by", { name: props.artifact.byName })} · {t("web.artifact.page.updated", { when: ago(props.artifact.updated, now()) })}
          </span>
          <span class="flex-1" />
          <OutLink href={artifactPath(props.artifact.id, version().version)} label={t("web.artifact.page.open")} />
          <ConfirmButton
            label={t("web.artifact.page.delete")}
            question={t("web.artifact.page.deleteAsk")}
            tone="danger"
            icon="delete"
            testid="artifact-delete"
            onConfirm={remove}
          />
        </div>
        <Show
          when={props.artifact.kind === "html"}
          fallback={
            <div data-testid="artifact-text" class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line p-5">
              <Show when={ready(text, undefined)} fallback={<Quiet>{text.isError ? reasonOf(text.error) : ""}</Quiet>}>
                {(c) => <Markdown text={c().content} />}
              </Show>
            </div>
          }
        >
          <iframe
            data-testid="artifact-frame"
            title={t("web.artifact.page.frame", { title: props.artifact.title, version: version().version })}
            src={artifactPath(props.artifact.id, version().version)}
            sandbox={sandbox}
            referrerpolicy="no-referrer"
            class="min-h-0 w-full flex-1 rounded-lg border border-line bg-page"
          />
        </Show>
      </section>
      <aside class="flex shrink-0 flex-col gap-3 lg:w-80">
        <h3 class="text-xs font-semibold text-muted">{t("web.artifact.page.versions")}</h3>
        <ol data-testid="artifact-versions" class="flex flex-col gap-1">
          <For each={[...props.artifact.versions].reverse()} keyed={(v) => v.version}>
            {(v) => (
              <li>
                <button
                  type="button"
                  data-key={v().version}
                  aria-pressed={v().version === version().version ? "true" : "false"}
                  onClick={() => pick(v().version)}
                  class={[
                    "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left",
                    v().version === version().version ? "bg-selected" : "hover:bg-hover",
                  ]}
                >
                  <span class="text-sm font-medium">
                    {t("web.artifact.card.version", { version: v().version })}{" "}
                    <span class="text-xs font-normal text-muted">
                      · {v().byName} · {ago(v().at, now())}
                    </span>
                  </span>
                  <Show when={v().note}>{(note) => <span class="text-xs text-muted">{note()}</span>}</Show>
                </button>
              </li>
            )}
          </For>
        </ol>
        <A href={messageHref(version())} data-testid="artifact-message" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          <Icon name="chat" size={12} />
          {t("web.artifact.talk.atMessage")}
        </A>
        <Reply artifact={props.artifact} version={version()} />
      </aside>
    </div>
  );
}

/** A reply to the version shown, under the message that said it: what its maker is woken with. */
function Reply(props: { artifact: Artifact; version: ArtifactVersion }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const send = async () => {
    const words = text().trim();
    if (!words || busy()) return;
    setBusy(true);
    try {
      await api.channel.message.send({
        id: props.version.channel,
        text: words,
        ...(props.version.number !== undefined ? { replyTo: props.version.number } : {}),
      });
      setText("");
      toast(t("web.artifact.talk.sent", { version: props.version.version }));
    } catch (e) {
      toast(reasonOf(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <TextArea
        data-testid="artifact-reply"
        aria-label={t("web.artifact.talk.reply")}
        placeholder={t("web.artifact.talk.replyHint")}
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <Button type="submit" tone="primary" icon="reply" disabled={!text().trim() || busy()} data-testid="artifact-send" class="self-end">
        {t("web.artifact.talk.send")}
      </Button>
    </form>
  );
}
