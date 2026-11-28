import { computed, effect, Image, PanResponder, signal, Text, untracked, View, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueId, MediaAnnotation, MediaAnnotationRect, MediaAnnotationSeverity } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { mix, tone } from "../../../design/tone";
import { VdpAnchor } from "../../../infra/vdpProbe";
import { resolveIssueRef } from "./docOps";
import {
  ANNOTATION_SEVERITIES,
  computeContainedImageFrame,
  filterVisibleAnnotations,
  makeAnnotationId,
  nextAnnotationNumber,
  normalizedRectToPixels,
  popoverPositionForRect,
  rectFromDragPoints,
  severityVisualOf,
  translateNormalizedRect,
} from "./mediaAnnotationModel";

function severityLabel(sev: MediaAnnotationSeverity): string {
  return t(`web.note.annotation.severity.${sev}`);
}

interface MediaAnnotationOverlayProps {
  readonly scopeId: string;
  readonly annotations: readonly MediaAnnotation[];
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly naturalWidth?: number | undefined;
  readonly naturalHeight?: number | undefined;
  readonly showOverlay: boolean;
  readonly unresolvedOnly: boolean;
  readonly addMode?: boolean | undefined;
  readonly editable?: boolean | undefined;
  readonly selectedId?: string | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly onSelect?: ((id: string | undefined) => void) | undefined;
  readonly onChange?: ((next: readonly MediaAnnotation[]) => void) | undefined;
  readonly onExitAddMode?: (() => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onCreateIssue?: ((ann: MediaAnnotation) => Promise<IssueId | undefined> | IssueId | undefined) | undefined;
  readonly onJumpToBaseRow?: ((rowId: string, annId: string) => void) | undefined;
}

export function MediaAnnotationOverlay(props: MediaAnnotationOverlayProps) {
  const hoveredId = signal<string | undefined>(undefined);
  const editingId = signal<string | undefined>(undefined);
  const draftRect = signal<MediaAnnotationRect | undefined>(undefined);
  const draggingMove = signal<{ readonly id: string; readonly rect: MediaAnnotationRect } | undefined>(undefined);
  let overlayRef: ViewRef | undefined;
  let overlayOrigin = { x: 0, y: 0 };

  const frame = computed(() => computeContainedImageFrame(props.containerWidth, props.containerHeight, props.naturalWidth, props.naturalHeight));

  const visible = computed(() => filterVisibleAnnotations(props.annotations, props.showOverlay, props.unresolvedOnly));

  const inspectedId = computed(() => {
    const sel = props.selectedId;
    if (sel !== undefined && visible().some((a) => a.id === sel)) return sel;
    const hov = hoveredId();
    if (hov !== undefined && visible().some((a) => a.id === hov)) return hov;
    return undefined;
  });

  const inspected = computed(() => {
    const id = inspectedId();
    return id !== undefined ? visible().find((a) => a.id === id) : undefined;
  });

  const inspectedPixelRect = computed(() => {
    const ann = inspected();
    if (!ann) return undefined;
    const move = draggingMove();
    const r = move?.id === ann.id ? move.rect : ann.rect;
    return normalizedRectToPixels(r, frame());
  });

  const popoverPos = computed(() => {
    const px = inspectedPixelRect();
    if (!px) return { left: 8, top: 8 };
    const isEdit = editingId() === inspected()?.id;
    return popoverPositionForRect(px, props.containerWidth, props.containerHeight, 268, isEdit ? 236 : 156);
  });

  const refreshOrigin = (after?: () => void) => {
    void overlayRef?.measure().then(
      (measured) => {
        if (measured) {
          overlayOrigin = { x: measured.pagePosition.x, y: measured.pagePosition.y };
          after?.();
        }
      },
      () => {},
    );
  };

  let drawStart = { x: 0, y: 0 };
  const drawPan = PanResponder.create({
    onStartShouldSetPanResponder: () => props.addMode === true && props.editable !== false,
    onMoveShouldSetPanResponder: () => props.addMode === true && props.editable !== false,
    onPanResponderGrant: (_e, g) => {
      const start = (ox: number, oy: number) => {
        drawStart = { x: g.x0 - ox, y: g.y0 - oy };
        draftRect.set(rectFromDragPoints(drawStart.x, drawStart.y, drawStart.x, drawStart.y, untracked(frame)));
      };
      start(overlayOrigin.x, overlayOrigin.y);
      refreshOrigin(() => start(overlayOrigin.x, overlayOrigin.y));
    },
    onPanResponderMove: (_e, g) => {
      const curX = g.moveX - overlayOrigin.x;
      const curY = g.moveY - overlayOrigin.y;
      draftRect.set(rectFromDragPoints(drawStart.x, drawStart.y, curX, curY, untracked(frame)));
    },
    onPanResponderRelease: (_e, g) => {
      const endX = (g.moveX !== 0 ? g.moveX : g.x0) - overlayOrigin.x;
      const endY = (g.moveY !== 0 ? g.moveY : g.y0) - overlayOrigin.y;
      const rect = rectFromDragPoints(drawStart.x, drawStart.y, endX, endY, untracked(frame));
      draftRect.set(undefined);
      const current = untracked(() => props.annotations);
      const num = nextAnnotationNumber(current);
      const created: MediaAnnotation = {
        id: makeAnnotationId(),
        rect,
        number: num,
        severity: "p1",
        title: t("web.note.annotation.defaultTitle", { n: num }),
        status: "open",
      };
      props.onChange?.([...current, created]);
      props.onSelect?.(created.id);
      editingId.set(created.id);
      props.onExitAddMode?.();
    },
    onPanResponderTerminate: () => {
      draftRect.set(undefined);
    },
  });

  const updateAnnotation = (id: string, patch: Partial<MediaAnnotation>) => {
    const next = untracked(() => props.annotations).map((item) => (item.id === id ? { ...item, ...patch } : item));
    props.onChange?.(next);
  };

  const deleteAnnotation = (id: string) => {
    const next = untracked(() => props.annotations).filter((item) => item.id !== id);
    props.onChange?.(next);
    if (untracked(editingId) === id) editingId.set(undefined);
    if (untracked(() => props.selectedId) === id) props.onSelect?.(undefined);
  };

  const createIssueForAnnotation = (ann: MediaAnnotation) => {
    if (!props.onCreateIssue) return;
    void Promise.resolve(props.onCreateIssue(ann)).then((madeId) => {
      if (madeId !== undefined) {
        updateAnnotation(ann.id, { issueId: madeId });
      }
    });
  };

  return (
    <View
      ref={(el) => {
        overlayRef = el;
      }}
      testID={`media-annot-overlay-${props.scopeId}`}
      onLayout={() => refreshOrigin()}
      class="absolute inset-0"
    >
      <If when={props.addMode === true && props.editable !== false}>
        <View
          {...drawPan.panHandlers}
          testID={`media-annot-draw-layer-${props.scopeId}`}
          class="absolute inset-0 z-10 cursor-crosshair"
          style={{ backgroundColor: mix("accent", 0.04) }}
        />
      </If>

      <If when={draftRect()}>
        {(dr) => {
          const px = () => normalizedRectToPixels(dr(), frame());
          return (
            <View
              testID={`media-annot-draft-${props.scopeId}`}
              class="pointer-events-none absolute z-10 rounded-xs border-2 border-dashed border-accent"
              style={{
                left: px().left,
                top: px().top,
                width: px().width,
                height: px().height,
                backgroundColor: mix("accent", 0.14),
              }}
            />
          );
        }}
      </If>

      <Each of={visible()} key={(a) => a.id}>
        {(ann) => {
          const visual = () => severityVisualOf(ann().severity);
          const isResolved = () => ann().status === "resolved";
          const isSelected = () => props.selectedId === ann().id;
          const isHovered = () => hoveredId() === ann().id;
          const isActive = () => isSelected() || isHovered();
          const dimmed = () => props.selectedId !== undefined && !isSelected() && !isHovered();
          const activeRect = () => {
            const drag = draggingMove();
            return drag?.id === ann().id ? drag.rect : ann().rect;
          };
          const px = () => normalizedRectToPixels(activeRect(), frame());
          const colorToken = () => (isResolved() ? "leaf" : visual().token);

          let moveOriginRect: MediaAnnotationRect = untracked(() => ann().rect);
          const movePan = PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_e, g) => props.editable !== false && props.addMode !== true && (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
            onPanResponderGrant: () => {
              moveOriginRect = untracked(() => ann().rect);
              draggingMove.set({ id: untracked(() => ann().id), rect: moveOriginRect });
            },
            onPanResponderMove: (_e, g) => {
              const moved = translateNormalizedRect(moveOriginRect, g.dx, g.dy, untracked(frame));
              draggingMove.set({ id: untracked(() => ann().id), rect: moved });
            },
            onPanResponderRelease: (_e, g) => {
              const moved = translateNormalizedRect(moveOriginRect, g.dx, g.dy, untracked(frame));
              draggingMove.set(undefined);
              updateAnnotation(
                untracked(() => ann().id),
                { rect: moved },
              );
            },
            onPanResponderTerminate: () => {
              draggingMove.set(undefined);
            },
          });

          return (
            <View
              {...movePan.panHandlers}
              role="button"
              testID={`media-annot-pin-${ann().id}`}
              accessibilityLabel={`#${ann().number} ${ann().title}`}
              accessibilityState={{ selected: isSelected() }}
              onMouseEnter={() => hoveredId.set(ann().id)}
              onMouseLeave={() => {
                if (untracked(hoveredId) === ann().id) hoveredId.set(undefined);
              }}
              onPress={() => {
                const next = untracked(() => props.selectedId) === ann().id ? undefined : ann().id;
                props.onSelect?.(next);
                if (next === undefined) editingId.set(undefined);
              }}
              class={`absolute rounded-xs border-2 ${isResolved() ? "border-dashed" : ""} ${isActive() ? "shadow-raise" : ""}`}
              style={{
                left: px().left,
                top: px().top,
                width: px().width,
                height: px().height,
                borderColor: tone(colorToken()),
                backgroundColor: mix(colorToken(), isActive() ? 0.22 : isResolved() ? 0.05 : 0.09),
                opacity: dimmed() ? 0.45 : isResolved() ? 0.72 : 1,
                zIndex: isActive() ? 15 : 5,
              }}
            >
              <VdpAnchor
                testId={`media-annot-pin-${ann().id}`}
                role="button"
                text={() => `#${ann().number} ${ann().title}`}
                onPress={() => props.onSelect?.(ann().id)}
              />
              <View
                class={`absolute -top-2.5 -left-2.5 h-5 min-w-5 flex-row items-center justify-center rounded-full border border-page px-1 shadow-raise ${
                  isResolved() ? "bg-leaf" : visual().badgeBgClass
                }`}
              >
                <If
                  when={isResolved()}
                  else={<Text class={`font-mono text-2xs font-bold tabular-nums ${visual().badgeTextClass}`}>{String(ann().number)}</Text>}
                >
                  <Icon name="check" size={10} tone="paper" />
                </If>
              </View>
            </View>
          );
        }}
      </Each>

      <If when={inspected()}>
        {(ann) => {
          const visual = () => severityVisualOf(ann().severity);
          const isResolved = () => ann().status === "resolved";
          const isEditing = () => editingId() === ann().id && props.editable !== false;
          const resolvedIssue = () => (ann().issueId ? resolveIssueRef(props.issues ?? [], ann().issueId!) : undefined);
          return (
            <View
              testID={`media-annot-popover-${ann().id}`}
              class="absolute z-30 w-68 gap-2 rounded-lg border border-line-strong bg-elevated p-2.5 shadow-float"
              style={{ left: popoverPos().left, top: popoverPos().top }}
            >
              <VdpAnchor testId={`media-annot-popover-${ann().id}`} role="dialog" text={() => `${ann().title} ${ann().body ?? ""}`} />
              <View class="flex-row items-center justify-between gap-1.5">
                <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                  <View class={`h-5 min-w-5 items-center justify-center rounded-full px-1 ${isResolved() ? "bg-leaf" : visual().badgeBgClass}`}>
                    <Text class={`font-mono text-2xs font-bold tabular-nums ${isResolved() ? "text-paper" : visual().badgeTextClass}`}>
                      {`#${ann().number}`}
                    </Text>
                  </View>
                  <View
                    class={`rounded-xs px-1.5 py-px ${visual().pillBgClass}`}
                    style={visual().mixToken !== undefined ? { backgroundColor: mix("water", 0.14) } : undefined}
                  >
                    <Text class={`font-mono text-2xs font-semibold ${visual().pillTextClass}`}>{severityLabel(ann().severity)}</Text>
                  </View>
                  <View class={`rounded-xs px-1.5 py-px ${isResolved() ? "bg-ok-soft" : "bg-side"}`}>
                    <Text class={`text-2xs font-medium ${isResolved() ? "text-ok-ink" : "text-muted"}`}>
                      {isResolved() ? t("web.note.annotation.status.resolved") : t("web.note.annotation.status.open")}
                    </Text>
                  </View>
                </View>
                <IconButton
                  icon="close"
                  size={12}
                  label={t("web.base.lightbox.close")}
                  testid={`media-annot-close-${ann().id}`}
                  onClick={() => {
                    editingId.set(undefined);
                    hoveredId.set(undefined);
                    props.onSelect?.(undefined);
                  }}
                />
              </View>

              <If
                when={isEditing()}
                else={
                  <View class="gap-1">
                    <Text class="text-xs font-semibold text-ink">{ann().title}</Text>
                    <If when={ann().body}>{(body) => <Text class="text-xs leading-relaxed text-muted">{body()}</Text>}</If>
                    <If when={ann().author}>{(author) => <Text class="text-2xs text-faint">{author()}</Text>}</If>
                  </View>
                }
              >
                <View class="gap-1.5">
                  <View class="flex-row items-center gap-1">
                    <Each of={ANNOTATION_SEVERITIES} key={(sev) => sev}>
                      {(sev) => {
                        const sevVis = () => severityVisualOf(sev());
                        const active = () => ann().severity === sev();
                        return (
                          <View
                            role="button"
                            testID={`media-annot-sev-${sev()}-${ann().id}`}
                            onPress={() => updateAnnotation(ann().id, { severity: sev() })}
                            class={`rounded-xs border px-1.5 py-0.5 ${active() ? "border-focus bg-selected" : "border-line bg-page hover:bg-hover"}`}
                          >
                            <Text class={`font-mono text-2xs font-semibold ${sevVis().pillTextClass}`}>{severityLabel(sev())}</Text>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                  <TextInput
                    testID={`media-annot-title-input-${ann().id}`}
                    value={ann().title}
                    placeholder={t("web.note.annotation.titlePlaceholder")}
                    onInput={(v) => updateAnnotation(ann().id, { title: v })}
                  />
                  <TextArea
                    testID={`media-annot-body-input-${ann().id}`}
                    rows={2}
                    value={ann().body ?? ""}
                    placeholder={t("web.note.annotation.bodyPlaceholder")}
                    onInput={(v) => updateAnnotation(ann().id, { body: v || undefined })}
                    class="text-xs"
                  />
                </View>
              </If>

              <View class="flex-row flex-wrap items-center justify-between gap-1 border-t border-line pt-1.5">
                <View class="flex-row flex-wrap items-center gap-1">
                  <If when={props.editable !== false}>
                    <Button
                      size="compact"
                      tone={isResolved() ? "plain" : "quiet"}
                      icon={isResolved() ? "refresh" : "check"}
                      testID={`media-annot-resolve-${ann().id}`}
                      onPress={() => updateAnnotation(ann().id, { status: isResolved() ? "open" : "resolved" })}
                    >
                      {isResolved() ? t("web.note.annotation.reopen") : t("web.note.annotation.resolve")}
                    </Button>
                  </If>
                  <If when={ann().baseRowId !== undefined && props.onJumpToBaseRow !== undefined}>
                    <Button
                      size="compact"
                      tone="quiet"
                      icon="log"
                      testID={`media-annot-jump-row-${ann().id}`}
                      onPress={() => props.onJumpToBaseRow?.(ann().baseRowId!, ann().id)}
                    >
                      {t("web.note.annotation.jumpToRow")}
                    </Button>
                  </If>
                  <If
                    when={ann().issueId}
                    else={
                      <If when={props.onCreateIssue !== undefined}>
                        <Button
                          size="compact"
                          tone="quiet"
                          icon="issues"
                          testID={`media-annot-create-issue-${ann().id}`}
                          onPress={() => createIssueForAnnotation(ann())}
                        >
                          {t("web.note.annotation.createIssue")}
                        </Button>
                      </If>
                    }
                  >
                    {(issId) => (
                      <Button
                        size="compact"
                        tone="quiet"
                        icon="issues"
                        testID={`media-annot-issue-${ann().id}`}
                        onPress={() => props.onOpenIssue?.(resolvedIssue()?.id ?? issId())}
                      >
                        {resolvedIssue() ? `#${resolvedIssue()!.number}` : t("web.note.annotation.openIssue")}
                      </Button>
                    )}
                  </If>
                </View>
                <If when={props.editable !== false}>
                  <View class="flex-row items-center gap-0.5">
                    <IconButton
                      icon={isEditing() ? "check" : "edit"}
                      size={12}
                      label={isEditing() ? t("web.note.annotation.save") : t("web.note.annotation.edit")}
                      testid={`media-annot-edit-${ann().id}`}
                      onClick={() => editingId.set(isEditing() ? undefined : ann().id)}
                    />
                    <IconButton
                      icon="delete"
                      size={12}
                      label={t("web.note.annotation.delete")}
                      testid={`media-annot-delete-${ann().id}`}
                      onClick={() => deleteAnnotation(ann().id)}
                    />
                  </View>
                </If>
              </View>
            </View>
          );
        }}
      </If>
    </View>
  );
}

interface MediaAnnotationStageProps {
  readonly scopeId: string;
  readonly src: string;
  readonly caption?: string | undefined;
  readonly annotations: readonly MediaAnnotation[];
  readonly editable?: boolean | undefined;
  readonly stageClass?: string | undefined;
  readonly selectedAnnotationId?: string | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly onSelectAnnotation?: ((id: string | undefined) => void) | undefined;
  readonly onChangeAnnotations?: ((next: readonly MediaAnnotation[]) => void) | undefined;
  readonly onOpenLightbox?: (() => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onCreateIssue?: ((ann: MediaAnnotation) => Promise<IssueId | undefined> | IssueId | undefined) | undefined;
  readonly onJumpToBaseRow?: ((rowId: string, annId: string) => void) | undefined;
}

/** Image stage with natural aspect measurement, restraint annotation toolbar, and non-destructive interactive pin overlay. */
export function MediaAnnotationStage(props: MediaAnnotationStageProps) {
  const showOverlay = signal(true);
  const unresolvedOnly = signal(false);
  const addMode = signal(false);
  const localSelectedId = signal<string | undefined>(undefined);
  const bounds = signal({ width: 0, height: 0 });
  const natural = signal<{ readonly src: string; readonly width: number; readonly height: number } | undefined>(undefined);

  effect(() => {
    const src = props.src;
    if (!src) {
      natural.set(undefined);
      return;
    }
    let active = true;
    void Image.getSize(src).then(
      (size) => active && natural.set({ src, width: size.width, height: size.height }),
      () => active && natural.set(undefined),
    );
    return () => {
      active = false;
    };
  });

  const activeSelectedId = computed(() => (props.onSelectAnnotation !== undefined ? props.selectedAnnotationId : localSelectedId()));
  const handleSelect = (id: string | undefined) => {
    if (props.onSelectAnnotation !== undefined) props.onSelectAnnotation(id);
    else localSelectedId.set(id);
  };

  const openCount = computed(() => props.annotations.filter((a) => a.status !== "resolved").length);
  const totalCount = computed(() => props.annotations.length);
  const natSame = computed(() => {
    const n = natural();
    return n !== undefined && n.src === props.src ? n : undefined;
  });

  return (
    <View testID={`media-annot-stage-wrap-${props.scopeId}`} class="group gap-1.5">
      <If when={totalCount() > 0 || addMode()}>
        <View class="flex-row flex-wrap items-center justify-between gap-1.5">
          <View class="flex-row items-center gap-1.5">
            <If when={totalCount() > 0}>
              <View testID={`media-annot-count-${props.scopeId}`} class="flex-row items-center gap-1 rounded-sm bg-page px-1.5 py-0.5">
                <Icon name="pin" size={11} tone="accent" />
                <Text class="font-mono text-2xs font-medium text-muted tabular-nums">
                  {t("web.note.annotation.openCount", { open: openCount(), total: totalCount() })}
                </Text>
              </View>
            </If>
            <If when={addMode()}>
              <Text class="text-2xs font-medium text-accent">{t("web.note.annotation.addModeHint")}</Text>
            </If>
          </View>
          <View class="flex-row items-center gap-1">
            <If when={totalCount() > 0}>
              <Button
                size="compact"
                tone={showOverlay() ? "plain" : "quiet"}
                icon={showOverlay() ? "show" : "hide"}
                testID={`media-annot-toggle-${props.scopeId}`}
                onPress={() => showOverlay.set(!showOverlay())}
              >
                {showOverlay() ? t("web.note.annotation.hide") : t("web.note.annotation.show")}
              </Button>
              <If when={showOverlay()}>
                <Button
                  size="compact"
                  tone={unresolvedOnly() ? "primary" : "quiet"}
                  icon="filter"
                  testID={`media-annot-unresolved-${props.scopeId}`}
                  onPress={() => unresolvedOnly.set(!unresolvedOnly())}
                >
                  {t("web.note.annotation.unresolvedOnly")}
                </Button>
              </If>
            </If>
            <If when={props.editable !== false && props.onChangeAnnotations !== undefined}>
              <Button
                size="compact"
                tone={addMode() ? "primary" : "quiet"}
                icon="pin"
                testID={`media-annot-add-${props.scopeId}`}
                onPress={() => {
                  showOverlay.set(true);
                  addMode.set(!addMode());
                }}
              >
                {t("web.note.annotation.addMode")}
              </Button>
            </If>
            <If when={props.onOpenLightbox !== undefined}>
              <IconButton
                icon="enlarge"
                size={14}
                label={t("web.note.annotation.zoom")}
                testid={`media-annot-zoom-${props.scopeId}`}
                onClick={() => props.onOpenLightbox?.()}
              />
            </If>
          </View>
        </View>
      </If>

      <View
        testID={`media-annot-stage-${props.scopeId}`}
        onLayout={(e) => bounds.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
        class={`relative w-full overflow-hidden rounded-md border border-line bg-page ${props.stageClass ?? "h-64"}`}
      >
        <If
          when={
            totalCount() === 0 && !addMode() && (props.onOpenLightbox !== undefined || (props.editable !== false && props.onChangeAnnotations !== undefined))
          }
        >
          <View class="absolute top-2 right-2 z-20 flex-row items-center gap-1 rounded-md border border-line bg-elevated/95 p-0.5 opacity-0 shadow-float group-hover:opacity-100 focus-within:opacity-100">
            <If when={props.editable !== false && props.onChangeAnnotations !== undefined}>
              <Button
                size="compact"
                tone="quiet"
                icon="pin"
                testID={`media-annot-add-${props.scopeId}`}
                onPress={() => {
                  showOverlay.set(true);
                  addMode.set(true);
                }}
              >
                {t("web.note.annotation.addMode")}
              </Button>
            </If>
            <If when={props.onOpenLightbox !== undefined}>
              <IconButton
                icon="enlarge"
                size={14}
                label={t("web.note.annotation.zoom")}
                testid={`media-annot-zoom-${props.scopeId}`}
                onClick={() => props.onOpenLightbox?.()}
              />
            </If>
          </View>
        </If>
        <Image src={props.src} accessibilityLabel={props.caption || props.src} class="h-full w-full object-contain" />
        <MediaAnnotationOverlay
          scopeId={props.scopeId}
          annotations={props.annotations}
          containerWidth={bounds().width > 0 ? bounds().width : 560}
          containerHeight={bounds().height > 0 ? bounds().height : 256}
          naturalWidth={natSame()?.width}
          naturalHeight={natSame()?.height}
          showOverlay={showOverlay()}
          unresolvedOnly={unresolvedOnly()}
          addMode={addMode()}
          editable={props.editable}
          selectedId={activeSelectedId()}
          issues={props.issues}
          onSelect={handleSelect}
          onChange={props.onChangeAnnotations}
          onExitAddMode={() => addMode.set(false)}
          onOpenIssue={props.onOpenIssue}
          onCreateIssue={props.onCreateIssue}
          onJumpToBaseRow={props.onJumpToBaseRow}
        />
      </View>

      <If when={showOverlay() && totalCount() > 0}>
        <View testID={`media-annot-strip-${props.scopeId}`} class="flex-row flex-wrap items-center gap-1.5 pt-0.5">
          <Each of={filterVisibleAnnotations(props.annotations, true, unresolvedOnly())} key={(a) => a.id}>
            {(ann) => {
              const visual = () => severityVisualOf(ann().severity);
              const isSelected = () => activeSelectedId() === ann().id;
              const isResolved = () => ann().status === "resolved";
              return (
                <View
                  role="button"
                  testID={`media-annot-chip-${ann().id}`}
                  accessibilityState={{ selected: isSelected() }}
                  onPress={() => {
                    const next = activeSelectedId() === ann().id ? undefined : ann().id;
                    handleSelect(next);
                  }}
                  class={`flex-row items-center gap-1.5 rounded-md border px-2 py-0.5 ${
                    isSelected() ? "border-focus bg-selected" : "border-line bg-page hover:bg-hover"
                  }`}
                >
                  <View class={`size-4 items-center justify-center rounded-full ${isResolved() ? "bg-leaf" : visual().badgeBgClass}`}>
                    <Text class={`font-mono text-2xs font-bold tabular-nums ${isResolved() ? "text-paper" : visual().badgeTextClass}`}>
                      {String(ann().number)}
                    </Text>
                  </View>
                  <Text class={`max-w-44 truncate text-2xs ${isResolved() ? "text-faint line-through" : "text-ink"}`}>{ann().title}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}
