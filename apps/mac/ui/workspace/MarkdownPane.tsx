// Rendered Markdown preview of a file (Rust pushes its text as `doc`).
import { Scroll, Text, View } from "nsh";
import { Button, TextView } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { act, frame, hostApi } from "../infra/bridge";
import { richNative } from "../infra/rich";
import { startEllipsis } from "./chrome";

type Doc = { path: string; markdown?: string; error?: string };

interface DocPathInfo {
  fileName: string;
  baseDir?: string;
  parentDisplay?: string;
}

function splitDocPath(rawPath: string): DocPathInfo {
  const normalized = rawPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) {
    return { fileName: normalized || rawPath };
  }
  if (slash === 0) {
    return { fileName: normalized.slice(1) || "/", baseDir: "/", parentDisplay: "/" };
  }
  const baseDir = normalized.slice(0, slash);
  return {
    fileName: normalized.slice(slash + 1),
    baseDir,
    parentDisplay: baseDir,
  };
}

function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const stack: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!absolute) {
        stack.push("..");
      }
    } else {
      stack.push(part);
    }
  }
  return (absolute ? "/" : "") + stack.join("/");
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveLocalLink(rawUrl: string, baseDir?: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  if (/^file:\/\//iu.test(trimmed)) {
    const rest = trimmed.slice("file://".length).replace(/^localhost(?=\/)/iu, "");
    const stripped = rest.split(/[?#]/u, 1)[0] ?? "";
    const decoded = safeDecodeUri(stripped);
    return decoded ? normalizePosixPath(decoded) : null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) {
    return null;
  }

  const stripped = trimmed.split(/[?#]/u, 1)[0] ?? "";
  if (!stripped) return null;
  const decoded = safeDecodeUri(stripped);
  if (decoded.startsWith("/")) {
    return normalizePosixPath(decoded);
  }
  if (baseDir) {
    return normalizePosixPath(`${baseDir}/${decoded}`);
  }
  return normalizePosixPath(decoded);
}

export function MarkdownPane() {
  const doc = frame<Doc>("doc");
  const native = richNative();
  const showSkeleton = useDelayedBusy(() => !doc()?.error && doc()?.markdown == null);
  const pathInfo = () => {
    const cur = doc();
    return cur?.path ? splitDocPath(cur.path) : undefined;
  };

  const handleLinkPress = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^(?:https?|mailto):/iu.test(trimmed)) {
      void hostApi.openUrl(trimmed);
      return;
    }
    const localPath = resolveLocalLink(trimmed, pathInfo()?.baseDir);
    if (localPath) {
      act({ type: "open_file", path: localPath });
      return;
    }
    void hostApi.openUrl(trimmed);
  };

  return (
    <View testID="markdown-pane" class="min-h-0 flex-1 bg-page">
      {pathInfo() ? (
        <View testID="markdown-pane-header" class="h-9 shrink-0 flex-row items-center justify-between gap-3 border-b border-line bg-side px-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <Icon name="file" size={13} tone="muted" />
            <Text class="shrink-0 text-xs font-semibold text-ink">{pathInfo()!.fileName}</Text>
            {pathInfo()!.parentDisplay ? (
              <Text class="min-w-0 flex-1 truncate text-xs text-faint" style={startEllipsis}>
                {pathInfo()!.parentDisplay}
              </Text>
            ) : null}
          </View>
          <Button
            testID="markdown-pane-source"
            accessibilityLabel={t("web.shell.markdown.openSource")}
            onPress={() => {
              const cur = doc();
              if (cur?.path) act({ type: "open_file", path: cur.path });
            }}
            class="h-6 shrink-0 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name="edit" size={11} tone="muted" />
            <Text class="text-xs font-medium text-muted">{t("web.shell.markdown.source")}</Text>
          </Button>
        </View>
      ) : null}
      <Scroll class="min-h-0 flex-1 bg-page" contentClass="w-full items-center">
        <View class="mx-auto w-full max-w-[820px] px-10 py-8">
          {doc()?.error ? (
            <View class="rounded-lg border border-line bg-bad-soft px-4 py-3">
              <Text class="text-sm text-berry">{doc()!.error}</Text>
            </View>
          ) : doc()?.markdown != null ? (
            native ? (
              <native.VvMarkdown
                text={doc()!.markdown!}
                size="doc"
                baseDir={pathInfo()?.baseDir ?? null}
                selectable
                onLinkPress={(e) => handleLinkPress(e.url)}
              />
            ) : (
              <TextView markdown={doc()!.markdown} selectable onLinkPress={(e) => handleLinkPress(e.url)} />
            )
          ) : showSkeleton() ? (
            <View testID="markdown-pane-skeleton" accessibilityLabel={t("web.shell.markdown.loadingPreview")} accessibilityState={{ busy: true }} class="gap-5">
              <View class="gap-3">
                <SkeletonBar width="42%" height={26} class="rounded-md" />
                <View class="h-px bg-line" />
              </View>
              <SkeletonLines rows={["94%", "88%", "68%"]} gap="md" rowHeight={13} />
              <SkeletonBar width="100%" height={180} class="rounded-lg" />
              <View class="gap-3">
                <SkeletonBar width="32%" height={18} class="rounded-md" />
                <SkeletonLines rows={["92%", "84%", "72%"]} gap="md" rowHeight={13} />
              </View>
            </View>
          ) : null}
        </View>
      </Scroll>
    </View>
  );
}
