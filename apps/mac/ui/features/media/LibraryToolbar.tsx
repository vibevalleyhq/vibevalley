import { Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { LibrarySort } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Select } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Segmented } from "../../design/Segmented";
import { CountPill } from "../../design/Tag";
import { type ContentBucket, contentSidebarOpen, openContentSearch } from "../../infra/state/contentNav";
import { setLibraryTile } from "../../infra/state/prefs";
import { type ContentCategoryFilter, emptyCategoryFilter, hasAnyCategoryFilter } from "./items";
import { isMediaMakeSupported } from "./LibraryDialogs";
import { bucketFileKind, showsMediaInBucket } from "./libraryView";

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function LibraryToolbar(props: {
  readonly bucketTitle: string;
  readonly bucket: ContentBucket;
  readonly totalCount: number;
  readonly hasCategoryOptions: boolean;
  readonly compactToolbar: boolean;
  readonly activeCategoryCount: number;
  readonly category: ContentCategoryFilter;
  readonly effectiveCategory: ContentCategoryFilter;
  readonly categoryOptions: { readonly repos: readonly FilterOption[]; readonly issues: readonly FilterOption[]; readonly channels: readonly FilterOption[] };
  readonly effectiveSort: LibrarySort;
  readonly sortOptions: readonly { readonly value: LibrarySort; readonly label: string }[];
  readonly tile: number;
  readonly hasVisibleMedia: boolean;
  readonly appsOnly: boolean;
  readonly pinnedOnly: boolean;
  readonly busy: boolean;
  readonly onCategory: (next: ContentCategoryFilter) => void;
  readonly onSort: (next: LibrarySort) => void;
  readonly onMake: (make: "audio" | "image") => void;
  readonly onPickFiles: () => void;
}) {
  return (
    <View
      role="toolbar"
      accessibilityLabel={props.bucketTitle}
      desktop={{ windowDrag: true }}
      class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3"
    >
      <If when={!contentSidebarOpen.get()}>
        <IconButton
          icon="sidebar"
          size={16}
          label={t("web.library.content.sidebarToggle")}
          testid="content-sidebar-toggle"
          pressed={false}
          onClick={() => contentSidebarOpen.set(true)}
        />
      </If>
      <View class="min-w-0 flex-row items-center gap-2">
        <Text testID="library-bucket-title" class="truncate text-sm font-semibold text-ink">
          {props.bucketTitle}
        </Text>
        <CountPill count={props.totalCount} />
      </View>
      <If when={props.hasCategoryOptions}>
        <If
          when={!props.compactToolbar}
          else={
            <Popover
              placement="bottom"
              align="start"
              offset={6}
              popupClass="w-72 gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-float"
              popupStyle={{ maxWidth: Math.max(240, windowSize().width - 24) }}
              trigger={
                <View
                  testID="library-filter-popover"
                  role="button"
                  accessibilityLabel={t("web.issue.page.filter")}
                  class={`h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line px-2.5 ${
                    props.activeCategoryCount > 0 ? "bg-selected" : "bg-page hover:bg-hover"
                  }`}
                >
                  <Icon name="filter" size={14} tone={props.activeCategoryCount > 0 ? "accent" : "muted"} />
                  <Text class="text-sm text-ink">{t("web.issue.page.filter")}</Text>
                  <If when={props.activeCategoryCount > 0}>
                    <CountPill count={props.activeCategoryCount} active />
                  </If>
                </View>
              }
            >
              <View testID="library-filter-popover-menu" class="gap-2.5">
                <If when={props.categoryOptions.repos.length > 0}>
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted">{t("web.issue.page.byRepo")}</Text>
                    <Select
                      size="control"
                      class="w-full"
                      label={t("web.issue.page.byRepo")}
                      testid="library-filter-repo"
                      filter
                      value={props.category.repo ?? ""}
                      placeholder={t("web.issue.page.allRepos")}
                      options={props.categoryOptions.repos}
                      onChange={(repo) => props.onCategory({ ...props.category, repo: repo || undefined })}
                    />
                  </View>
                </If>
                <If when={props.categoryOptions.issues.length > 0}>
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted">{t("web.base.place.issues.label")}</Text>
                    <Select
                      size="control"
                      class="w-full"
                      label={t("web.base.place.issues.label")}
                      testid="library-filter-issue"
                      filter
                      value={props.category.issueId ?? ""}
                      placeholder={t("web.issue.list.all")}
                      options={props.categoryOptions.issues}
                      onChange={(issueId) => props.onCategory({ ...props.category, issueId: issueId || undefined })}
                    />
                  </View>
                </If>
                <If when={props.categoryOptions.channels.length > 0}>
                  <View class="gap-1">
                    <Text class="text-xs font-medium text-muted">{t("web.channel.channelsTitle")}</Text>
                    <Select
                      size="control"
                      class="w-full"
                      label={t("web.channel.channelsTitle")}
                      testid="library-filter-channel"
                      filter
                      value={props.category.channelId ?? ""}
                      placeholder={t("web.channel.filter.all")}
                      options={props.categoryOptions.channels}
                      onChange={(channelId) => props.onCategory({ ...props.category, channelId: channelId || undefined })}
                    />
                  </View>
                </If>
                <If when={hasAnyCategoryFilter(props.effectiveCategory)}>
                  <View class="flex-row justify-end border-t border-line pt-2">
                    <Button size="compact" tone="quiet" testID="library-filter-clear" onPress={() => props.onCategory(emptyCategoryFilter)}>
                      {t("web.issue.page.clear")}
                    </Button>
                  </View>
                </If>
              </View>
            </Popover>
          }
        >
          <View testID="library-filter-bar" class="shrink-0 flex-row items-center rounded-md border border-line bg-side pl-2">
            <Icon name="filter" size={14} tone={props.activeCategoryCount > 0 ? "accent" : "faint"} />
            <If when={props.categoryOptions.repos.length > 0}>
              <View class="mx-1.5 h-3.5 w-px bg-line" />
              <Select
                quiet
                size="control"
                class="max-w-24"
                label={t("web.issue.page.byRepo")}
                testid="library-filter-repo"
                filter
                value={props.category.repo ?? ""}
                placeholder={t("web.issue.page.allRepos")}
                options={props.categoryOptions.repos}
                onChange={(repo) => props.onCategory({ ...props.category, repo: repo || undefined })}
              />
            </If>
            <If when={props.categoryOptions.issues.length > 0}>
              <View class="h-3.5 w-px bg-line" />
              <Select
                quiet
                size="control"
                class="max-w-28"
                label={t("web.base.place.issues.label")}
                testid="library-filter-issue"
                filter
                value={props.category.issueId ?? ""}
                placeholder={t("web.issue.list.all")}
                options={props.categoryOptions.issues}
                onChange={(issueId) => props.onCategory({ ...props.category, issueId: issueId || undefined })}
              />
            </If>
            <If when={props.categoryOptions.channels.length > 0}>
              <View class="h-3.5 w-px bg-line" />
              <Select
                quiet
                size="control"
                class="max-w-24"
                label={t("web.channel.channelsTitle")}
                testid="library-filter-channel"
                filter
                value={props.category.channelId ?? ""}
                placeholder={t("web.channel.filter.all")}
                options={props.categoryOptions.channels}
                onChange={(channelId) => props.onCategory({ ...props.category, channelId: channelId || undefined })}
              />
            </If>
          </View>
          <If when={hasAnyCategoryFilter(props.effectiveCategory)}>
            <IconButton
              icon="close"
              size={14}
              testid="library-filter-clear"
              label={t("web.issue.page.clear")}
              onClick={() => props.onCategory(emptyCategoryFilter)}
            />
          </If>
        </If>
      </If>
      <View class="min-w-0 flex-1" />
      <If when={!contentSidebarOpen.get()}>
        <IconButton icon="search" size={14} label={t("web.library.content.searchAll")} testid="content-search-btn" onClick={() => openContentSearch()} />
      </If>
      <Select
        label={t("web.library.sortLabel")}
        testid="library-sort"
        size="control"
        quiet
        value={props.effectiveSort}
        onChange={(v) => props.onSort(v)}
        options={props.sortOptions}
      />
      <If when={showsMediaInBucket(props.bucket) && props.hasVisibleMedia}>
        <Segmented
          label={t("web.library.tileSize")}
          testid="library-tile-size"
          value={props.tile <= 128 ? "sm" : props.tile >= 220 ? "lg" : "md"}
          onChange={(v) => setLibraryTile(v === "sm" ? 112 : v === "lg" ? 240 : 160)}
          options={[
            { value: "sm", label: "S" },
            { value: "md", label: "M" },
            { value: "lg", label: "L" },
          ]}
        />
      </If>
      <If when={isMediaMakeSupported(props.bucket)}>
        <Button
          size="compact"
          tone="quiet"
          testID="library-make-btn"
          icon="generate"
          onPress={() => props.onMake(bucketFileKind(props.bucket) === "audio" ? "audio" : "image")}
        >
          {t("web.library.make")}
        </Button>
      </If>
      <If when={!props.appsOnly && !props.pinnedOnly}>
        <Button size="compact" tone="quiet" testID="library-upload" icon="upload" disabled={props.busy} onPress={() => props.onPickFiles()}>
          {props.busy ? t("web.library.uploading") : t("web.library.upload")}
        </Button>
      </If>
    </View>
  );
}
