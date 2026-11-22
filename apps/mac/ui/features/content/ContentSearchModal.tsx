import { keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { LibraryFileKind } from "@vibevalley/protocol";

import { Dialog } from "../../design/Dialog";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Kbd } from "../../design/layout";
import { api } from "../../infra/api";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { spelled } from "../../infra/base/search";
import { ready, useQuery } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { useLatest } from "../../infra/state/atom";
import { artifactIcon, kindLabel, useArtifacts } from "../artifact";
import { artifactHref } from "../artifact/ArtifactCard";
import { libraryQuery } from "../media/listing";
import { titleFor } from "../pkm/days";
import { pkmHref, usePkmVault } from "../pkm/vault";
import { closeContentSearch, contentBrowseBucket, contentFocusMediaId, contentSearchOpen, mediaKindOf } from "./navigation";

export function ContentSearchModal() {
  return (
    <Dialog open={contentSearchOpen.get()} onClose={closeContentSearch} title={t("web.library.content.search.title")} wide testid="content-search-modal">
      <If when={contentSearchOpen.get()}>
        <SearchBody />
      </If>
    </Dialog>
  );
}

type SearchHit =
  | {
      readonly key: string;
      readonly kind: "note";
      readonly slug: string;
      readonly title: string;
      readonly subtitle: string;
      readonly badge: string;
      readonly icon: IconName;
      readonly updated: number;
    }
  | {
      readonly key: string;
      readonly kind: "noteBlock";
      readonly slug: string;
      readonly block: string;
      readonly title: string;
      readonly subtitle: string;
      readonly badge: string;
      readonly icon: IconName;
      readonly updated: number;
    }
  | {
      readonly key: string;
      readonly kind: "artifact";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly badge: string;
      readonly icon: IconName;
      readonly updated: number;
    }
  | {
      readonly key: string;
      readonly kind: "media";
      readonly id: string;
      readonly fileKind: LibraryFileKind;
      readonly title: string;
      readonly subtitle: string;
      readonly badge: string;
      readonly icon: IconName;
      readonly updated: number;
    };

const mediaIcon: Record<LibraryFileKind, IconName> = {
  image: "image",
  audio: "audio",
  video: "video",
  other: "file",
};

function SearchBody() {
  const router = useRouter();
  const now = useNow();
  const vault = usePkmVault();
  const artifacts = useArtifacts(() => ({}));
  const media = useQuery(() => libraryQuery({ text: "", sort: "recent" }), { interval: () => 10_000, keepPrevious: true });

  const query = signal("");
  const active = signal(0);

  const blockSearch = useLatest(
    () => {
      const q = query().trim();
      return q.length > 0 ? q : undefined;
    },
    (text) => api.pkm.search({ text, limit: 15 }),
    150,
  );

  const hits = createMemo((): readonly SearchHit[] => {
    const q = query().trim().toLowerCase();
    const pages = ready(vault, undefined)?.pages ?? [];
    const pageDays = new Map(pages.flatMap((p) => (p.day ? [[p.slug, p.day] as const] : [])));
    const allArtifacts = ready(artifacts, undefined) ?? [];
    const allMedia = ready(media, undefined) ?? [];
    const currentNow = now();

    const noteHits: SearchHit[] = pages
      .filter((p) => !q || spelled(titleFor(p.title, p.day), q) || spelled(p.tldr, q))
      .map((p) => ({
        key: `note:${p.slug}`,
        kind: "note",
        slug: p.slug,
        title: titleFor(p.title, p.day),
        subtitle: p.tldr || ago(p.updated, currentNow),
        badge: t("web.library.content.search.typeNote"),
        icon: p.day ? "calendar" : "notes",
        updated: p.updated,
      }));

    const matchedNoteSlugs = new Set(noteHits.map((h) => (h.kind === "note" ? h.slug : "")));
    const blockAnswer = blockSearch();
    const blockHits: SearchHit[] =
      q && blockAnswer?.state === "done"
        ? blockAnswer.value
            .filter((b) => !matchedNoteSlugs.has(b.page) || b.plain.trim() !== "")
            .slice(0, 8)
            .map((b) => ({
              key: `block:${b.block}`,
              kind: "noteBlock",
              slug: b.page,
              block: b.block,
              title: titleFor(b.pageTitle, pageDays.get(b.page)),
              subtitle: b.plain,
              badge: t("web.library.content.search.typeNote"),
              icon: "notes",
              updated: currentNow,
            }))
        : [];

    const artifactHits: SearchHit[] = allArtifacts
      .filter((a) => !q || spelled(a.title, q) || spelled(kindLabel(a), q))
      .map((a) => ({
        key: `artifact:${a.id}`,
        kind: "artifact",
        id: a.id,
        title: a.title,
        subtitle: `${a.byName} · ${ago(a.updated, currentNow)}`,
        badge: kindLabel(a),
        icon: artifactIcon(a),
        updated: a.updated,
      }));

    const mediaHits: SearchHit[] = allMedia
      .filter((m) => !q || spelled(m.attachment.name, q))
      .map((m) => {
        const fk = mediaKindOf(m.attachment.type);
        return {
          key: `media:${m.attachment.id}`,
          kind: "media",
          id: m.attachment.id,
          fileKind: fk,
          title: m.attachment.name,
          subtitle: ago(m.lastAt, currentNow),
          badge: `${t("web.library.content.search.typeMedia")} · ${t(`web.library.kind.${fk}`)}`,
          icon: mediaIcon[fk],
          updated: m.lastAt,
        };
      });

    if (!q) {
      return [...artifactHits, ...mediaHits, ...noteHits].toSorted((a, b) => b.updated - a.updated).slice(0, 14);
    }

    return [...artifactHits.slice(0, 10), ...mediaHits.slice(0, 8), ...noteHits.slice(0, 6), ...blockHits].slice(0, 24);
  });

  const openHit = (hit: SearchHit) => {
    closeContentSearch();
    switch (hit.kind) {
      case "note":
        router.navigate(pkmHref(hit.slug));
        return;
      case "noteBlock":
        router.navigate(pkmHref(hit.slug, hit.block));
        return;
      case "artifact":
        router.navigate(artifactHref(hit.id));
        return;
      case "media":
        contentBrowseBucket.set({ kind: "media" });
        contentFocusMediaId.set(hit.id);
        router.navigate("/library");
        return;
    }
  };

  const clampedIndex = () => {
    const n = hits().length;
    if (n === 0) return -1;
    return Math.min(active(), n - 1);
  };

  const move = (delta: number) => {
    const n = hits().length;
    if (n === 0) return;
    active.set((clampedIndex() + delta + n) % n);
  };

  keymap.bind({ up: () => move(-1), down: () => move(1) }, { when: "always" });

  return (
    <View class="gap-3">
      <View class="h-10 flex-row items-center gap-2 rounded-md border border-line bg-page px-3 hover:border-faint focus-within:border-focus">
        <Icon name="search" size={16} tone="muted" />
        <Input
          autoFocus
          testID="content-search-input"
          value={query()}
          placeholder={t("web.library.content.search.placeholder")}
          accessibilityLabel={t("web.library.content.search.title")}
          submitBehavior="submit"
          onChange={(e) => {
            query.set(e.value);
            active.set(0);
          }}
          onSubmit={() => {
            const idx = clampedIndex();
            const chosen = idx >= 0 ? hits()[idx] : undefined;
            if (chosen) openHit(chosen);
          }}
          class="min-w-0 flex-1 text-base text-ink placeholder:text-faint"
        />
        <If when={query().length > 0}>
          <View
            role="button"
            accessibilityLabel={t("web.issue.page.clear")}
            onPress={() => {
              query.set("");
              active.set(0);
            }}
            class="size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
          >
            <Icon name="close" size={12} tone="muted" />
          </View>
        </If>
      </View>

      <Scroll accessibilityLabel={t("web.library.content.search.title")} style={{ maxHeight: Math.max(240, windowSize().height * 0.54) }} contentClass="gap-1">
        <If when={hits().length === 0}>
          <Text class="px-2 py-6 text-center text-sm text-muted">{t("web.library.content.search.empty")}</Text>
        </If>
        <Each of={hits()} key={(h) => h.key}>
          {(hit, idx) => {
            const selected = () => idx() === clampedIndex();
            return (
              <View
                role="button"
                testID="content-search-hit"
                accessibilityLabel={hit().title}
                accessibilityState={{ selected: selected() }}
                onMouseEnter={() => active.set(idx())}
                onPress={() => openHit(hit())}
                class={`flex-row items-center gap-2.5 rounded-md px-2.5 py-2 ${selected() ? "bg-selected" : "hover:bg-hover"}`}
              >
                <Icon name={hit().icon} size={16} tone={selected() ? "ink" : "muted"} />
                <View class="min-w-0 flex-1 gap-0.5">
                  <Text class="truncate text-sm font-medium text-ink">{hit().title}</Text>
                  <Text class="truncate text-xs text-muted">{hit().subtitle}</Text>
                </View>
                <View class="shrink-0 rounded-sm border border-line bg-side px-1.5 py-0.5">
                  <Text class="text-2xs font-medium text-muted">{hit().badge}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </Scroll>

      <View class="flex-row items-center gap-3 border-t border-line pt-2">
        <View class="flex-row items-center gap-1">
          <Kbd>↑↓</Kbd>
          <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.move")}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <Kbd>⏎</Kbd>
          <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.pick")}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <Kbd>Esc</Kbd>
          <Text class="text-2xs text-faint">{t("web.base.lightbox.close")}</Text>
        </View>
      </View>
    </View>
  );
}
