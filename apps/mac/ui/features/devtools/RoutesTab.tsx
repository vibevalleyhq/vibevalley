import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../design/Button";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Empty } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { act } from "../../infra/bridge";
import { parseRouteState, QUICK_ROUTES } from "./format";
import { SectionHeader } from "./shared";

export function RoutesTab(props: { routes: unknown }) {
  const query = signal("");
  const routeState = computed(() => parseRouteState(props.routes));
  const needle = () => query().trim().toLowerCase();

  const quickRoutes = computed(() => {
    const q = needle();
    if (!q) return QUICK_ROUTES;
    return QUICK_ROUTES.filter((path) => path.toLowerCase().includes(q));
  });

  const projects = computed(() => {
    const list = routeState()?.projects ?? [];
    const q = needle();
    if (!q) return list;
    return list.filter((p) => {
      const hitProject =
        (p.name?.toLowerCase().includes(q) ?? false) || (p.path?.toLowerCase().includes(q) ?? false) || (p.branch?.toLowerCase().includes(q) ?? false);
      if (hitProject) return true;
      return (p.tabs ?? []).some((tab) => (tab.title?.toLowerCase().includes(q) ?? false) || (tab.kind?.toLowerCase().includes(q) ?? false));
    });
  });

  const jumpTo = (path: string) => {
    act({ type: "open_route", path });
  };

  return (
    <Scroll testID="devtools-routes" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <SearchField
        value={query()}
        onInput={(v) => query.set(v)}
        placeholder={t("web.devtools.routes.searchPlaceholder")}
        label={t("web.devtools.routes.searchPlaceholder")}
        testid="routes-search"
      />

      <View class="gap-2">
        <SectionHeader title={t("web.devtools.tabs.routes")} count={quickRoutes().length} />
        <View class="flex-row flex-wrap gap-1.5">
          <Each of={quickRoutes()}>
            {(path) => (
              <Button
                size="compact"
                tone={routeState()?.current === path() ? "primary" : "plain"}
                icon="open"
                testID={`route-jump-${path().slice(1)}`}
                onPress={() => jumpTo(path())}
              >
                {path()}
              </Button>
            )}
          </Each>
        </View>
      </View>

      <If
        when={routeState()}
        else={
          <Empty compact icon="branch" testid="routes-empty">
            {t("web.devtools.routes.empty")}
          </Empty>
        }
      >
        {(state) => (
          <View class="gap-3">
            <View class="flex-row flex-wrap items-center gap-2 rounded-md border border-line bg-page px-3 py-2">
              <Icon name="branch" size={14} tone="muted" />
              <Text testID="routes-current" class="font-mono text-xs font-medium text-ink">
                {state().current ?? "/"}
              </Text>
              <If when={state().nativeWorkspace !== undefined}>
                <Tag tone={state().nativeWorkspace === true ? "ok" : "neutral"} label={`nativeWorkspace:${String(state().nativeWorkspace)}`} />
              </If>
              <If when={state().panel}>{(panel) => <Tag tone="info" label={`panel:${panel()}`} />}</If>
              <If when={state().inspectorOpen !== undefined}>
                <Tag tone={state().inspectorOpen === true ? "wait" : "neutral"} label={`inspector:${String(state().inspectorOpen)}`} />
              </If>
            </View>

            <If when={projects().length > 0}>
              <View class="gap-2">
                <Each of={projects()}>
                  {(project) => (
                    <View class="gap-1.5 rounded-md border border-line bg-page p-2.5">
                      <View class="flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                          <Icon name="folder" size={14} tone={project().active === true ? "accent" : "muted"} />
                          <Text class="truncate text-xs font-semibold text-ink">{project().name ?? project().path ?? "—"}</Text>
                          <If when={project().branch}>{(br) => <Tag tone="neutral" label={br()} />}</If>
                        </View>
                        <If when={project().active === true}>
                          <Tag tone="ok" label="active" />
                        </If>
                      </View>
                      <If when={project().path}>{(p) => <Text class="truncate font-mono text-2xs text-faint">{p()}</Text>}</If>
                      <If when={(project().tabs ?? []).length > 0}>
                        <View class="gap-1 pt-1">
                          <Each of={project().tabs ?? []}>
                            {(tab) => (
                              <View class="flex-row items-center justify-between gap-2 rounded-sm border border-line bg-side px-2 py-1">
                                <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                                  <Text class="truncate text-xs text-ink">{tab().title ?? "—"}</Text>
                                  <If when={tab().kind}>{(kind) => <Tag tone="neutral" label={kind()} />}</If>
                                </View>
                                <View class="flex-row items-center gap-1">
                                  <If when={tab().runningState}>{(rs) => <Tag tone="info" label={rs()} />}</If>
                                  <If when={tab().active === true}>
                                    <Tag tone="ok" label="active" />
                                  </If>
                                </View>
                              </View>
                            )}
                          </Each>
                        </View>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        )}
      </If>
    </Scroll>
  );
}
