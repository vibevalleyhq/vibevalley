import { t } from "@vibevalley/i18n";
import type { ArtifactFileWriteItem } from "@vibevalley/protocol";

export type VisualTemplateSeed = "designWorkspaceUi" | "dsPapertrails" | "motionLaunchReel" | "storyboardProductFilm";

function jsonWriteItem(path: string, data: unknown): ArtifactFileWriteItem {
  return {
    path,
    content: `${JSON.stringify(data, null, 2)}\n`,
    encoding: "utf8",
    mime: "application/json",
  };
}

function buildDesignWorkspaceUi(title: string): ArtifactFileWriteItem[] {
  const desktop = {
    id: "desktop-workspace",
    name: t("web.library.content.templates.seed.designDesktopName"),
    viewport: { x: 0, y: 0, w: 1280, h: 800 },
    theme: "light",
    props: [
      {
        name: "density",
        label: t("web.library.content.templates.seed.designPropDensity"),
        type: "select",
        options: ["comfortable", "compact"],
        value: "comfortable",
      },
      { name: "showBanner", label: t("web.library.content.templates.seed.designPropBanner"), type: "boolean", value: true },
      {
        name: "ctaLabel",
        label: t("web.library.content.templates.seed.designPropCta"),
        type: "text",
        value: t("web.library.content.templates.seed.designPropCtaDefault"),
      },
    ],
    root: {
      id: "root",
      kind: "stack",
      direction: "vertical",
      gap: "{space.4}",
      padding: "{space.6}",
      fill: "{color.surface}",
      children: [
        {
          id: "hero_banner",
          kind: "card",
          visibleWhen: "showBanner",
          fill: "{color.panel}",
          radius: "{radius.md}",
          children: [
            { id: "hero_badge", kind: "badge", text: "LIVE RELEASE", fill: "{color.accent}", color: "{color.surface}" },
            { id: "hero_title", kind: "text", variant: "heading", text: title },
            { id: "hero_sub", kind: "text", variant: "muted", text: t("web.library.content.templates.seed.designHeroSub") },
          ],
        },
        {
          id: "cards_row",
          kind: "stack",
          direction: "horizontal",
          gap: "{space.4}",
          children: [
            {
              id: "metrics_card",
              kind: "card",
              radius: "{radius.md}",
              fill: "{color.panel}",
              children: [
                { id: "metrics_title", kind: "text", variant: "heading", text: t("web.library.content.templates.seed.designMetricsTitle") },
                {
                  id: "metrics_table",
                  kind: "table",
                  columns: ["Metric", "Target", "Current"],
                  rows: [
                    ["P99 Latency", "< 45ms", "28ms"],
                    ["Availability", "99.95%", "99.98%"],
                    ["Render FPS", "60 fps", "60 fps"],
                  ],
                },
              ],
            },
            {
              id: "action_card",
              kind: "card",
              radius: "{radius.md}",
              fill: "{color.panel}",
              children: [
                { id: "action_title", kind: "text", variant: "heading", text: t("web.library.content.templates.seed.designActionTitle") },
                { id: "action_input", kind: "input", text: "dev.vibevalley.applet.workspace" },
                { id: "action_btn", kind: "button", variant: "primary", text: "{props.ctaLabel}" },
              ],
            },
          ],
        },
      ],
    },
  };

  const mobile = {
    id: "mobile-companion",
    name: t("web.library.content.templates.seed.designMobileName"),
    viewport: { x: 1360, y: 0, w: 390, h: 844 },
    theme: "dark",
    props: [
      {
        name: "ctaLabel",
        label: t("web.library.content.templates.seed.designPropCta"),
        type: "text",
        value: t("web.library.content.templates.seed.designPropCtaDefault"),
      },
    ],
    root: {
      id: "m_root",
      kind: "stack",
      direction: "vertical",
      gap: "{space.3}",
      padding: "{space.4}",
      fill: "{color.surface}",
      children: [
        { id: "m_badge", kind: "badge", text: "MOBILE" },
        { id: "m_title", kind: "text", variant: "heading", text: title },
        { id: "m_preview", kind: "image", src: "asset/mobile-preview.png", h: 110 },
        { id: "m_btn", kind: "button", variant: "primary", text: "{props.ctaLabel}" },
      ],
    },
  };

  return [jsonWriteItem("structure/frames/main.json", desktop), jsonWriteItem("structure/frames/mobile-companion.json", mobile)];
}

function buildDesignSystemPapertrails(title: string): ArtifactFileWriteItem[] {
  const tokens = {
    name: title,
    version: "1.0.0",
    defaultTheme: "light",
    color: [
      { id: "surface", group: "surface", value: { light: "#fcfcfb", dark: "#151413" }, note: "Primary canvas surface" },
      { id: "panel", group: "surface", value: { light: "#f4f3ef", dark: "#1f1d1b" }, note: "Secondary panel & card" },
      { id: "ink", group: "text", value: { light: "#1c1917", dark: "#ecebe8" }, note: "Primary copy" },
      { id: "muted", group: "text", value: { light: "#6b655e", dark: "#a69f95" }, note: "Captions & metadata" },
      { id: "accent", group: "brand", value: { light: "#4d7a2a", dark: "#7fae4f" }, note: "Primary brand action" },
      { id: "danger", group: "status", value: { light: "#b83a2d", dark: "#e06c5f" }, note: "Destructive & alert" },
    ],
    type: {
      families: [
        { id: "sans", value: "system-ui, -apple-system, sans-serif" },
        { id: "mono", value: "ui-monospace, SFMono-Regular, monospace" },
      ],
      scale: [
        { id: "sm", value: "13px" },
        { id: "md", value: "15px" },
        { id: "xl", value: "24px" },
      ],
      styles: [
        { id: "heading", family: "{sans}", size: "{xl}", weight: 700, lineHeight: 1.2 },
        { id: "body", family: "{sans}", size: "{md}", weight: 400, lineHeight: 1.55 },
        { id: "caption", family: "{sans}", size: "{sm}", weight: 500, lineHeight: 1.4 },
      ],
    },
    space: [
      { id: "2", value: "8px" },
      { id: "4", value: "16px" },
      { id: "6", value: "24px" },
      { id: "8", value: "32px" },
    ],
    radius: [
      { id: "sm", value: "6px" },
      { id: "md", value: "10px" },
      { id: "lg", value: "16px" },
      { id: "full", value: "9999px" },
    ],
  };

  const btn = {
    id: "button",
    title: t("web.library.content.templates.seed.dsButtonTitle"),
    summary: t("web.library.content.templates.seed.dsButtonSummary"),
    variants: [
      { id: "primary", bg: "{color.accent}", fg: "{color.surface}" },
      { id: "secondary", bg: "{color.panel}", fg: "{color.ink}" },
      { id: "danger", bg: "{color.danger}", fg: "{color.surface}" },
    ],
    states: ["default", "hover", "active", "disabled"],
    guidelines: {
      do: [t("web.library.content.templates.seed.dsButtonDo")],
      dont: [t("web.library.content.templates.seed.dsButtonDont")],
    },
  };

  const badge = {
    id: "badge",
    title: t("web.library.content.templates.seed.dsBadgeTitle"),
    summary: t("web.library.content.templates.seed.dsBadgeSummary"),
    variants: [
      { id: "accent", bg: "{color.accent}", fg: "{color.surface}" },
      { id: "neutral", bg: "{color.panel}", fg: "{color.muted}" },
    ],
    states: ["default"],
    guidelines: {
      do: [t("web.library.content.templates.seed.dsBadgeDo")],
      dont: [],
    },
  };

  return [
    jsonWriteItem("structure/tokens.json", tokens),
    jsonWriteItem("structure/components/button.json", btn),
    jsonWriteItem("structure/components/badge.json", badge),
  ];
}

function buildMotionLaunchReel(title: string): ArtifactFileWriteItem[] {
  const timeline = {
    title,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 9.0,
    background: "#151413",
    chapters: [
      { at: 0, label: t("web.library.content.templates.seed.motionCh1") },
      { at: 3.0, label: t("web.library.content.templates.seed.motionCh2") },
      { at: 6.0, label: t("web.library.content.templates.seed.motionCh3") },
    ],
    scenes: [
      { id: "sc01-hook", file: "structure/scenes/sc01-hook.json", start: 0, end: 3.0 },
      { id: "sc02-features", file: "structure/scenes/sc02-features.json", start: 3.0, end: 6.0 },
      { id: "sc03-cta", file: "structure/scenes/sc03-cta.json", start: 6.0, end: 9.0 },
    ],
    audioTracks: [],
  };

  const sc1 = {
    id: "sc01-hook",
    title: t("web.library.content.templates.seed.motionCh1"),
    layers: [
      { id: "tag", kind: "badge", text: "PAPERTRAILS ENGINE" },
      { id: "headline", kind: "text", text: title },
      { id: "progress", kind: "bar", opacity: 0.9 },
    ],
  };

  const sc2 = {
    id: "sc02-features",
    title: t("web.library.content.templates.seed.motionCh2"),
    layers: [
      { id: "sub", kind: "text", text: t("web.library.content.templates.seed.motionSc2Headline") },
      {
        id: "card1",
        kind: "card",
        text: t("web.library.content.templates.seed.motionSc2CardTitle"),
        body: t("web.library.content.templates.seed.motionSc2CardBody"),
      },
    ],
  };

  const sc3 = {
    id: "sc03-cta",
    title: t("web.library.content.templates.seed.motionCh3"),
    layers: [
      { id: "cta", kind: "text", text: t("web.library.content.templates.seed.motionSc3Headline") },
      { id: "pill", kind: "badge", text: "vibevalley.dev" },
    ],
  };

  return [
    jsonWriteItem("structure/timeline.json", timeline),
    jsonWriteItem("structure/scenes/sc01-hook.json", sc1),
    jsonWriteItem("structure/scenes/sc02-features.json", sc2),
    jsonWriteItem("structure/scenes/sc03-cta.json", sc3),
  ];
}

function buildStoryboardProductFilm(title: string): ArtifactFileWriteItem[] {
  return [
    jsonWriteItem("structure/shots.json", {
      title,
      aspectRatio: "16:9",
      fps: 30,
      styleGuide: {
        visualTone: t("web.library.content.templates.seed.sbTone"),
        palette: ["#fcfcfb", "#1c1917", "#4d7a2a", "#2b7a9b"],
        continuityRefs: [],
      },
      shots: [
        {
          id: "sh01",
          scene: t("web.library.content.templates.seed.sbS1Scene"),
          durationSec: 2.5,
          framing: "wide",
          camera: "slow push-in",
          visual: t("web.library.content.templates.seed.sbS1Visual"),
          dialogue: t("web.library.content.templates.seed.sbS1Dialogue"),
          sfx: "soft paper fold",
          transitionOut: "crossfade",
          status: "ready",
        },
        {
          id: "sh02",
          scene: t("web.library.content.templates.seed.sbS2Scene"),
          durationSec: 3.0,
          framing: "screen-ui",
          camera: "static lock",
          visual: t("web.library.content.templates.seed.sbS2Visual"),
          dialogue: t("web.library.content.templates.seed.sbS2Dialogue"),
          sfx: "crisp keyclick",
          transitionOut: "cut",
          status: "approved",
        },
        {
          id: "sh03",
          scene: t("web.library.content.templates.seed.sbS3Scene"),
          durationSec: 2.5,
          framing: "close-up",
          camera: "rack focus",
          visual: t("web.library.content.templates.seed.sbS3Visual"),
          dialogue: t("web.library.content.templates.seed.sbS3Dialogue"),
          sfx: "chime",
          transitionOut: "match-cut",
          status: "draft",
        },
      ],
    }),
  ];
}

export function buildVisualSeedFiles(seed: VisualTemplateSeed, title: string): ArtifactFileWriteItem[] {
  switch (seed) {
    case "designWorkspaceUi":
      return buildDesignWorkspaceUi(title);
    case "dsPapertrails":
      return buildDesignSystemPapertrails(title);
    case "motionLaunchReel":
      return buildMotionLaunchReel(title);
    case "storyboardProductFilm":
      return buildStoryboardProductFilm(title);
  }
}
