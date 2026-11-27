import { t } from "@vibevalley/i18n";
import type { BaseCellValue, BaseColumn, BaseRow, BaseSheet, DocBlock, NoteFileWriteItem } from "@vibevalley/protocol";

import { buildDocFromMarkdown } from "../note/html";
import { type AppTemplateSeed, buildAppSeedFiles } from "./appSeeds";
import { buildVisualSeedFiles, type VisualTemplateSeed } from "./visualSeeds";

export type NoteTemplateVariant = "blank" | "tech" | "meeting" | "daily" | "prReview" | "debug" | "release" | "oncall" | "onboarding" | "sprintRetro";

export type WhiteboardTemplateVariant = "blank" | "arch" | "timeline" | "journey" | "workshop" | "eventStorming" | "c4" | "incidentMap" | "tradeoff";

export type DeliverableTemplateSeed =
  | "docRfc"
  | "docAdr"
  | "docPostmortem"
  | "docApiSpec"
  | "docRunbook"
  | "docSecurity"
  | "docMigration"
  | "docPerf"
  | "diagMicroservices"
  | "diagSequence"
  | "diagErd"
  | "diagCicd"
  | "diagStateMachine"
  | "sheetBenchmark"
  | "sheetTechMatrix"
  | "sheetTestMatrix"
  | "sheetApiInventory"
  | "dashSlo"
  | "dashDora"
  | "slidesArchReview"
  | "slidesReleaseDemo"
  | "protoApiPlayground"
  | "protoComponentLab"
  | AppTemplateSeed
  | VisualTemplateSeed;

export function noteStarterMarkdown(variant: NoteTemplateVariant): string {
  switch (variant) {
    case "blank":
      return "- \n";
    case "tech":
      return t("web.library.content.templates.seed.noteTech");
    case "meeting":
      return t("web.library.content.templates.seed.noteMeeting");
    case "daily":
      return t("web.library.content.templates.seed.noteDaily");
    case "prReview":
      return t("web.library.content.templates.seed.notePrReview");
    case "debug":
      return t("web.library.content.templates.seed.noteDebug");
    case "release":
      return t("web.library.content.templates.seed.noteRelease");
    case "oncall":
      return t("web.library.content.templates.seed.noteOncall");
    case "onboarding":
      return t("web.library.content.templates.seed.noteOnboarding");
    case "sprintRetro":
      return t("web.library.content.templates.seed.noteSprintRetro");
  }
}

interface SeedShape {
  readonly id: string;
  readonly shape: "card" | "sticky";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly body: string;
  readonly fill: "default" | "sun" | "peach" | "leaf" | "water" | "lavender" | "side";
}

interface SeedArrow {
  readonly id: string;
  readonly fromId: string;
  readonly fromSide: "n" | "e" | "s" | "w";
  readonly toId: string;
  readonly toSide: "n" | "e" | "s" | "w";
  readonly label?: string;
}

function boardSpecFor(variant: WhiteboardTemplateVariant): { readonly shapes: SeedShape[]; readonly arrows: SeedArrow[] } {
  switch (variant) {
    case "blank":
      return {
        shapes: [
          {
            id: "n1",
            shape: "card",
            x: 240,
            y: 160,
            w: 220,
            h: 108,
            title: t("web.library.content.templates.seed.wbBlankTitle"),
            body: t("web.library.content.templates.seed.wbBlankBody"),
            fill: "leaf",
          },
        ],
        arrows: [],
      };
    case "arch":
      return {
        shapes: [
          {
            id: "n1",
            shape: "card",
            x: 80,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbArchN1Title"),
            body: t("web.library.content.templates.seed.wbArchN1Body"),
            fill: "default",
          },
          {
            id: "n2",
            shape: "card",
            x: 348,
            y: 140,
            w: 210,
            h: 112,
            title: t("web.library.content.templates.seed.wbArchN2Title"),
            body: t("web.library.content.templates.seed.wbArchN2Body"),
            fill: "leaf",
          },
          {
            id: "n3",
            shape: "card",
            x: 626,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbArchN3Title"),
            body: t("web.library.content.templates.seed.wbArchN3Body"),
            fill: "water",
          },
        ],
        arrows: [
          { id: "a1", fromId: "n1", fromSide: "e", toId: "n2", toSide: "w", label: t("web.library.content.templates.seed.wbArchE1") },
          { id: "a2", fromId: "n2", fromSide: "e", toId: "n3", toSide: "w", label: t("web.library.content.templates.seed.wbArchE2") },
        ],
      };
    case "timeline":
      return {
        shapes: [
          {
            id: "p1",
            shape: "card",
            x: 80,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbTlP1Title"),
            body: t("web.library.content.templates.seed.wbTlP1Body"),
            fill: "sun",
          },
          {
            id: "p2",
            shape: "card",
            x: 348,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbTlP2Title"),
            body: t("web.library.content.templates.seed.wbTlP2Body"),
            fill: "leaf",
          },
          {
            id: "p3",
            shape: "card",
            x: 616,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbTlP3Title"),
            body: t("web.library.content.templates.seed.wbTlP3Body"),
            fill: "water",
          },
        ],
        arrows: [
          { id: "a1", fromId: "p1", fromSide: "e", toId: "p2", toSide: "w", label: "Week 1" },
          { id: "a2", fromId: "p2", fromSide: "e", toId: "p3", toSide: "w", label: "Week 2" },
        ],
      };
    case "journey":
      return {
        shapes: [
          {
            id: "j1",
            shape: "card",
            x: 80,
            y: 120,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbJourneyJ1Title"),
            body: t("web.library.content.templates.seed.wbJourneyJ1Body"),
            fill: "default",
          },
          {
            id: "j2",
            shape: "card",
            x: 348,
            y: 120,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbJourneyJ2Title"),
            body: t("web.library.content.templates.seed.wbJourneyJ2Body"),
            fill: "leaf",
          },
          {
            id: "j3",
            shape: "card",
            x: 616,
            y: 120,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbJourneyJ3Title"),
            body: t("web.library.content.templates.seed.wbJourneyJ3Body"),
            fill: "water",
          },
          {
            id: "s1",
            shape: "sticky",
            x: 348,
            y: 280,
            w: 200,
            h: 96,
            title: t("web.library.content.templates.seed.wbJourneyS1Title"),
            body: t("web.library.content.templates.seed.wbJourneyS1Body"),
            fill: "sun",
          },
        ],
        arrows: [
          { id: "a1", fromId: "j1", fromSide: "e", toId: "j2", toSide: "w", label: t("web.library.content.templates.seed.wbJourneyE1") },
          { id: "a2", fromId: "j2", fromSide: "e", toId: "j3", toSide: "w", label: t("web.library.content.templates.seed.wbJourneyE2") },
        ],
      };
    case "workshop":
      return {
        shapes: [
          {
            id: "w1",
            shape: "card",
            x: 300,
            y: 80,
            w: 220,
            h: 104,
            title: t("web.library.content.templates.seed.wbWorkW1Title"),
            body: t("web.library.content.templates.seed.wbWorkW1Body"),
            fill: "water",
          },
          {
            id: "w2",
            shape: "sticky",
            x: 140,
            y: 248,
            w: 200,
            h: 104,
            title: t("web.library.content.templates.seed.wbWorkW2Title"),
            body: t("web.library.content.templates.seed.wbWorkW2Body"),
            fill: "sun",
          },
          {
            id: "w3",
            shape: "sticky",
            x: 480,
            y: 248,
            w: 200,
            h: 104,
            title: t("web.library.content.templates.seed.wbWorkW3Title"),
            body: t("web.library.content.templates.seed.wbWorkW3Body"),
            fill: "leaf",
          },
        ],
        arrows: [
          { id: "a1", fromId: "w1", fromSide: "s", toId: "w2", toSide: "n", label: t("web.library.content.templates.seed.wbWorkE1") },
          { id: "a2", fromId: "w2", fromSide: "e", toId: "w3", toSide: "w", label: t("web.library.content.templates.seed.wbWorkE2") },
        ],
      };
    case "eventStorming":
      return {
        shapes: [
          {
            id: "es1",
            shape: "sticky",
            x: 60,
            y: 140,
            w: 190,
            h: 108,
            title: t("web.library.content.templates.seed.wbEsCmdTitle"),
            body: t("web.library.content.templates.seed.wbEsCmdBody"),
            fill: "water",
          },
          {
            id: "es2",
            shape: "card",
            x: 300,
            y: 140,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbEsAggTitle"),
            body: t("web.library.content.templates.seed.wbEsAggBody"),
            fill: "sun",
          },
          {
            id: "es3",
            shape: "sticky",
            x: 550,
            y: 140,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbEsEvtTitle"),
            body: t("web.library.content.templates.seed.wbEsEvtBody"),
            fill: "peach",
          },
          {
            id: "es4",
            shape: "card",
            x: 800,
            y: 140,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbEsReadTitle"),
            body: t("web.library.content.templates.seed.wbEsReadBody"),
            fill: "leaf",
          },
        ],
        arrows: [
          { id: "a1", fromId: "es1", fromSide: "e", toId: "es2", toSide: "w", label: t("web.library.content.templates.seed.wbEsE1") },
          { id: "a2", fromId: "es2", fromSide: "e", toId: "es3", toSide: "w", label: t("web.library.content.templates.seed.wbEsE2") },
          { id: "a3", fromId: "es3", fromSide: "e", toId: "es4", toSide: "w", label: t("web.library.content.templates.seed.wbEsE3") },
        ],
      };
    case "c4":
      return {
        shapes: [
          {
            id: "c1",
            shape: "card",
            x: 80,
            y: 140,
            w: 200,
            h: 112,
            title: t("web.library.content.templates.seed.wbC4EdgeTitle"),
            body: t("web.library.content.templates.seed.wbC4EdgeBody"),
            fill: "default",
          },
          {
            id: "c2",
            shape: "card",
            x: 350,
            y: 140,
            w: 210,
            h: 112,
            title: t("web.library.content.templates.seed.wbC4AppTitle"),
            body: t("web.library.content.templates.seed.wbC4AppBody"),
            fill: "leaf",
          },
          {
            id: "c3",
            shape: "card",
            x: 350,
            y: 310,
            w: 210,
            h: 104,
            title: t("web.library.content.templates.seed.wbC4QueueTitle"),
            body: t("web.library.content.templates.seed.wbC4QueueBody"),
            fill: "lavender",
          },
          {
            id: "c4",
            shape: "card",
            x: 630,
            y: 140,
            w: 210,
            h: 112,
            title: t("web.library.content.templates.seed.wbC4DbTitle"),
            body: t("web.library.content.templates.seed.wbC4DbBody"),
            fill: "water",
          },
        ],
        arrows: [
          { id: "a1", fromId: "c1", fromSide: "e", toId: "c2", toSide: "w", label: t("web.library.content.templates.seed.wbC4E1") },
          { id: "a2", fromId: "c2", fromSide: "s", toId: "c3", toSide: "n", label: t("web.library.content.templates.seed.wbC4E2") },
          { id: "a3", fromId: "c2", fromSide: "e", toId: "c4", toSide: "w", label: t("web.library.content.templates.seed.wbC4E3") },
        ],
      };
    case "incidentMap":
      return {
        shapes: [
          {
            id: "i1",
            shape: "card",
            x: 80,
            y: 180,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbIncSymTitle"),
            body: t("web.library.content.templates.seed.wbIncSymBody"),
            fill: "peach",
          },
          {
            id: "i2",
            shape: "sticky",
            x: 350,
            y: 90,
            w: 200,
            h: 104,
            title: t("web.library.content.templates.seed.wbIncHyp1Title"),
            body: t("web.library.content.templates.seed.wbIncHyp1Body"),
            fill: "sun",
          },
          {
            id: "i3",
            shape: "sticky",
            x: 350,
            y: 250,
            w: 200,
            h: 104,
            title: t("web.library.content.templates.seed.wbIncHyp2Title"),
            body: t("web.library.content.templates.seed.wbIncHyp2Body"),
            fill: "sun",
          },
          {
            id: "i4",
            shape: "card",
            x: 620,
            y: 180,
            w: 210,
            h: 108,
            title: t("web.library.content.templates.seed.wbIncFixTitle"),
            body: t("web.library.content.templates.seed.wbIncFixBody"),
            fill: "leaf",
          },
        ],
        arrows: [
          { id: "a1", fromId: "i1", fromSide: "e", toId: "i2", toSide: "w", label: t("web.library.content.templates.seed.wbIncE1") },
          { id: "a2", fromId: "i1", fromSide: "e", toId: "i3", toSide: "w", label: t("web.library.content.templates.seed.wbIncE2") },
          { id: "a3", fromId: "i2", fromSide: "e", toId: "i4", toSide: "w", label: t("web.library.content.templates.seed.wbIncE3") },
        ],
      };
    case "tradeoff":
      return {
        shapes: [
          {
            id: "t1",
            shape: "card",
            x: 80,
            y: 180,
            w: 200,
            h: 108,
            title: t("web.library.content.templates.seed.wbToReqTitle"),
            body: t("web.library.content.templates.seed.wbToReqBody"),
            fill: "water",
          },
          {
            id: "t2",
            shape: "card",
            x: 350,
            y: 90,
            w: 210,
            h: 104,
            title: t("web.library.content.templates.seed.wbToOptATitle"),
            body: t("web.library.content.templates.seed.wbToOptABody"),
            fill: "leaf",
          },
          {
            id: "t3",
            shape: "card",
            x: 350,
            y: 250,
            w: 210,
            h: 104,
            title: t("web.library.content.templates.seed.wbToOptBTitle"),
            body: t("web.library.content.templates.seed.wbToOptBBody"),
            fill: "side",
          },
          {
            id: "t4",
            shape: "card",
            x: 630,
            y: 180,
            w: 210,
            h: 108,
            title: t("web.library.content.templates.seed.wbToDecTitle"),
            body: t("web.library.content.templates.seed.wbToDecBody"),
            fill: "sun",
          },
        ],
        arrows: [
          { id: "a1", fromId: "t1", fromSide: "e", toId: "t2", toSide: "w", label: t("web.library.content.templates.seed.wbToE1") },
          { id: "a2", fromId: "t1", fromSide: "e", toId: "t3", toSide: "w", label: t("web.library.content.templates.seed.wbToE2") },
          { id: "a3", fromId: "t2", fromSide: "e", toId: "t4", toSide: "w", label: t("web.library.content.templates.seed.wbToE3") },
        ],
      };
  }
}

export function buildWhiteboardDocument(variant: WhiteboardTemplateVariant): Record<string, unknown> {
  const { shapes, arrows } = boardSpecFor(variant);
  const elements: Record<string, unknown> = {};
  for (const s of shapes) {
    elements[s.id] = { id: s.id, type: "shape", shape: s.shape, x: s.x, y: s.y, w: s.w, h: s.h, title: s.title, body: s.body, fill: s.fill };
  }
  for (const a of arrows) {
    elements[a.id] = {
      id: a.id,
      type: "arrow",
      curve: "smooth",
      head: "arrow",
      from: { id: a.fromId, side: a.fromSide },
      to: { id: a.toId, side: a.toSide },
      ...(a.label ? { label: a.label } : {}),
    };
  }
  return { version: 1, grid: "dots", viewport: { x: 0, y: 0, zoom: 1 }, elements };
}

function jsonWriteItem(path: string, value: unknown): NoteFileWriteItem {
  return { path, content: `${JSON.stringify(value, null, 2)}\n`, mime: "application/json" };
}

function textWriteItem(path: string, content: string, mime: string): NoteFileWriteItem {
  return { path, content, mime };
}

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function buildDocFiles(
  seed: "docRfc" | "docAdr" | "docPostmortem" | "docApiSpec" | "docRunbook" | "docSecurity" | "docMigration" | "docPerf",
  title: string,
): NoteFileWriteItem[] {
  const bodies: Record<typeof seed, string> = {
    docRfc: t("web.library.content.templates.seed.docRfcBody", { title }),
    docAdr: t("web.library.content.templates.seed.docAdrBody", { title }),
    docPostmortem: t("web.library.content.templates.seed.docPostmortemBody", { title }),
    docApiSpec: t("web.library.content.templates.seed.docApiSpecBody", { title }),
    docRunbook: t("web.library.content.templates.seed.docRunbookBody", { title }),
    docSecurity: t("web.library.content.templates.seed.docSecurityBody", { title }),
    docMigration: t("web.library.content.templates.seed.docMigrationBody", { title }),
    docPerf: t("web.library.content.templates.seed.docPerfBody", { title }),
  };
  return [jsonWriteItem("structure/doc.json", buildDocFromMarkdown(title, bodies[seed]))];
}

function buildDiagramFiles(seed: "diagMicroservices" | "diagSequence" | "diagErd" | "diagCicd" | "diagStateMachine", title: string): NoteFileWriteItem[] {
  const payload = (() => {
    switch (seed) {
      case "diagMicroservices":
        return {
          title,
          kind: "architecture",
          direction: "LR",
          nodes: [
            { id: "gw", label: t("web.library.content.templates.seed.diagMsNodeGateway"), kind: "gateway" },
            { id: "auth", label: t("web.library.content.templates.seed.diagMsNodeAuth"), kind: "service" },
            { id: "core", label: t("web.library.content.templates.seed.diagMsNodeCore"), kind: "service" },
            { id: "queue", label: t("web.library.content.templates.seed.diagMsNodeQueue"), kind: "queue" },
            { id: "media", label: t("web.library.content.templates.seed.diagMsNodeMedia"), kind: "service" },
            { id: "db", label: t("web.library.content.templates.seed.diagMsNodeDb"), kind: "database" },
          ],
          edges: [
            { id: "e1", from: "gw", to: "auth", label: t("web.library.content.templates.seed.diagMsEdgeAuth") },
            { id: "e2", from: "gw", to: "core", label: t("web.library.content.templates.seed.diagMsEdgeRpc") },
            { id: "e3", from: "core", to: "queue", label: t("web.library.content.templates.seed.diagMsEdgeEmit") },
            { id: "e4", from: "queue", to: "media", label: t("web.library.content.templates.seed.diagMsEdgeEmit") },
            { id: "e5", from: "core", to: "db", label: t("web.library.content.templates.seed.diagMsEdgeRead") },
            { id: "e6", from: "media", to: "db", label: t("web.library.content.templates.seed.diagMsEdgeStore") },
          ],
        };
      case "diagSequence":
        return {
          title,
          kind: "sequence",
          direction: "LR",
          nodes: [
            { id: "client", label: t("web.library.content.templates.seed.diagSeqClient"), kind: "client" },
            { id: "api", label: t("web.library.content.templates.seed.diagSeqApi"), kind: "gateway" },
            { id: "guard", label: t("web.library.content.templates.seed.diagSeqGuard"), kind: "module" },
            { id: "domain", label: t("web.library.content.templates.seed.diagSeqDomain"), kind: "service" },
            { id: "outbox", label: t("web.library.content.templates.seed.diagSeqOutbox"), kind: "database" },
            { id: "bus", label: t("web.library.content.templates.seed.diagSeqBus"), kind: "stream" },
          ],
          edges: [
            { id: "e1", from: "client", to: "api", label: t("web.library.content.templates.seed.diagSeqE1") },
            { id: "e2", from: "api", to: "guard", label: t("web.library.content.templates.seed.diagSeqE2") },
            { id: "e3", from: "guard", to: "domain", label: t("web.library.content.templates.seed.diagSeqE3") },
            { id: "e4", from: "domain", to: "outbox", label: t("web.library.content.templates.seed.diagSeqE4") },
            { id: "e5", from: "outbox", to: "bus", label: t("web.library.content.templates.seed.diagSeqE5") },
          ],
        };
      case "diagErd":
        return {
          title,
          kind: "erd",
          direction: "TB",
          nodes: [
            { id: "repo", label: t("web.library.content.templates.seed.diagErdRepo"), kind: "table" },
            { id: "agent", label: t("web.library.content.templates.seed.diagErdUser"), kind: "table" },
            { id: "issue", label: t("web.library.content.templates.seed.diagErdIssue"), kind: "table" },
            { id: "session", label: t("web.library.content.templates.seed.diagErdSession"), kind: "table" },
            { id: "artifact", label: t("web.library.content.templates.seed.diagErdArtifact"), kind: "table" },
            { id: "version", label: t("web.library.content.templates.seed.diagErdVersion"), kind: "table" },
          ],
          edges: [
            { id: "e1", from: "issue", to: "repo", label: t("web.library.content.templates.seed.diagErdE1") },
            { id: "e2", from: "issue", to: "session", label: t("web.library.content.templates.seed.diagErdE2") },
            { id: "e3", from: "session", to: "agent", label: t("web.library.content.templates.seed.diagErdE3") },
            { id: "e4", from: "session", to: "artifact", label: t("web.library.content.templates.seed.diagErdE4") },
            { id: "e5", from: "artifact", to: "version", label: t("web.library.content.templates.seed.diagErdE5") },
          ],
        };
      case "diagCicd":
        return {
          title,
          kind: "pipeline",
          direction: "LR",
          nodes: [
            { id: "lint", label: t("web.library.content.templates.seed.diagCiLint"), kind: "gate" },
            { id: "unit", label: t("web.library.content.templates.seed.diagCiUnit"), kind: "gate" },
            { id: "build", label: t("web.library.content.templates.seed.diagCiBuild"), kind: "build" },
            { id: "canary", label: t("web.library.content.templates.seed.diagCiCanary"), kind: "deploy" },
            { id: "smoke", label: t("web.library.content.templates.seed.diagCiSmoke"), kind: "verify" },
            { id: "prod", label: t("web.library.content.templates.seed.diagCiProd"), kind: "release" },
          ],
          edges: [
            { id: "e1", from: "lint", to: "unit", label: t("web.library.content.templates.seed.diagCiE1") },
            { id: "e2", from: "unit", to: "build", label: t("web.library.content.templates.seed.diagCiE2") },
            { id: "e3", from: "build", to: "canary", label: t("web.library.content.templates.seed.diagCiE3") },
            { id: "e4", from: "canary", to: "smoke", label: t("web.library.content.templates.seed.diagCiE4") },
            { id: "e5", from: "smoke", to: "prod", label: t("web.library.content.templates.seed.diagCiE5") },
          ],
        };
      case "diagStateMachine":
        return {
          title,
          kind: "state-machine",
          direction: "LR",
          nodes: [
            { id: "draft", label: t("web.library.content.templates.seed.diagSmDraft"), kind: "state" },
            { id: "queued", label: t("web.library.content.templates.seed.diagSmQueued"), kind: "state" },
            { id: "running", label: t("web.library.content.templates.seed.diagSmRunning"), kind: "state" },
            { id: "review", label: t("web.library.content.templates.seed.diagSmReview"), kind: "state" },
            { id: "done", label: t("web.library.content.templates.seed.diagSmDone"), kind: "terminal" },
            { id: "canceled", label: t("web.library.content.templates.seed.diagSmCanceled"), kind: "terminal" },
          ],
          edges: [
            { id: "e1", from: "draft", to: "queued", label: t("web.library.content.templates.seed.diagSmE1") },
            { id: "e2", from: "queued", to: "running", label: t("web.library.content.templates.seed.diagSmE2") },
            { id: "e3", from: "running", to: "review", label: t("web.library.content.templates.seed.diagSmE3") },
            { id: "e4", from: "review", to: "queued", label: t("web.library.content.templates.seed.diagSmE4") },
            { id: "e5", from: "review", to: "done", label: t("web.library.content.templates.seed.diagSmE5") },
            { id: "e6", from: "draft", to: "canceled", label: t("web.library.content.templates.seed.diagSmE6") },
          ],
        };
    }
  })();
  const mermaidLines = [
    `flowchart ${payload.direction}`,
    ...payload.nodes.map((n) => `  ${n.id}["${n.label.replaceAll('"', "'")}"]`),
    ...payload.edges.map((e) => `  ${e.from} -->|${e.label.replaceAll("|", "/")}| ${e.to}`),
  ];
  return [
    jsonWriteItem("structure/doc.json", {
      version: 1,
      blocks: [
        { id: "b1", type: "heading", level: 1, text: title },
        { id: "b2", type: "diagram", title, source: mermaidLines.join("\n") },
      ],
    }),
  ];
}

function toBaseSheet(
  id: string,
  name: string,
  columns: readonly { readonly key: string; readonly title: string; readonly type: "string" | "number" }[],
  rows: readonly Record<string, string | number>[],
): BaseSheet {
  const baseCols: BaseColumn[] = columns.map((c) => ({
    id: c.key,
    name: c.title,
    kind: c.type === "number" ? "number" : "text",
    width: c.type === "number" ? 130 : 200,
  }));
  const baseRows: BaseRow[] = rows.map((r, idx) => {
    const cells: Record<string, BaseCellValue> = {};
    for (const c of columns) {
      const val = r[c.key];
      cells[c.key] =
        c.type === "number" && typeof val === "number" ? { _tag: "number", value: val } : { _tag: "text", value: val !== undefined ? String(val) : "" };
    }
    return {
      id: `r${idx + 1}`,
      cells,
      createdAt: 0,
      updatedAt: 0,
    };
  });
  return {
    id,
    name,
    columns: baseCols,
    rows: baseRows,
    views: [{ id: `v_${id}_table`, name: t("web.note.base.table"), kind: "table" }],
  };
}

function buildSheetFiles(seed: "sheetBenchmark" | "sheetTechMatrix" | "sheetTestMatrix" | "sheetApiInventory", title: string): NoteFileWriteItem[] {
  switch (seed) {
    case "sheetBenchmark": {
      const tab1 = t("web.library.content.templates.seed.sheetBenchTab1");
      const tab2 = t("web.library.content.templates.seed.sheetBenchTab2");
      return [
        jsonWriteItem("structure/base.json", {
          version: 1,
          sheets: [
            toBaseSheet(
              "sheet1",
              tab1,
              [
                { key: "scenario", title: t("web.library.content.templates.seed.sheetBenchColCase"), type: "string" },
                { key: "baseline", title: t("web.library.content.templates.seed.sheetBenchColBaseline"), type: "number" },
                { key: "current", title: t("web.library.content.templates.seed.sheetBenchColCurrent"), type: "number" },
                { key: "p99", title: t("web.library.content.templates.seed.sheetBenchColP99"), type: "number" },
                { key: "mem", title: t("web.library.content.templates.seed.sheetBenchColMem"), type: "number" },
                { key: "status", title: t("web.library.content.templates.seed.sheetBenchColStatus"), type: "string" },
              ],
              [
                {
                  scenario: t("web.library.content.templates.seed.sheetBenchR1Case"),
                  baseline: 1420,
                  current: 2385,
                  p99: 4.2,
                  mem: 68,
                  status: t("web.library.content.templates.seed.sheetBenchR1Status"),
                },
                {
                  scenario: t("web.library.content.templates.seed.sheetBenchR2Case"),
                  baseline: 890,
                  current: 1352,
                  p99: 11.8,
                  mem: 112,
                  status: t("web.library.content.templates.seed.sheetBenchR2Status"),
                },
                {
                  scenario: t("web.library.content.templates.seed.sheetBenchR3Case"),
                  baseline: 310,
                  current: 520,
                  p99: 16.4,
                  mem: 94,
                  status: t("web.library.content.templates.seed.sheetBenchR3Status"),
                },
                {
                  scenario: t("web.library.content.templates.seed.sheetBenchR4Case"),
                  baseline: 640,
                  current: 690,
                  p99: 21.0,
                  mem: 86,
                  status: t("web.library.content.templates.seed.sheetBenchR4Status"),
                },
              ],
            ),
            toBaseSheet(
              "sheet2",
              tab2,
              [
                { key: "param", title: t("web.library.content.templates.seed.sheetBenchEnvKey"), type: "string" },
                { key: "value", title: t("web.library.content.templates.seed.sheetBenchEnvVal"), type: "string" },
              ],
              [
                { param: t("web.library.content.templates.seed.sheetBenchEnvR1"), value: "64" },
                { param: t("web.library.content.templates.seed.sheetBenchEnvR2"), value: "100,000 rows" },
                { param: t("web.library.content.templates.seed.sheetBenchEnvR3"), value: "5" },
              ],
            ),
          ],
        }),
      ];
    }
    case "sheetTechMatrix": {
      const tab = t("web.library.content.templates.seed.sheetTechTab");
      return [
        jsonWriteItem("structure/base.json", {
          version: 1,
          sheets: [
            toBaseSheet(
              "sheet1",
              tab || title,
              [
                { key: "dim", title: t("web.library.content.templates.seed.sheetTechColDim"), type: "string" },
                { key: "weight", title: t("web.library.content.templates.seed.sheetTechColWeight"), type: "number" },
                { key: "optA", title: t("web.library.content.templates.seed.sheetTechColOptA"), type: "number" },
                { key: "optB", title: t("web.library.content.templates.seed.sheetTechColOptB"), type: "number" },
                { key: "note", title: t("web.library.content.templates.seed.sheetTechColNote"), type: "string" },
              ],
              [
                {
                  dim: t("web.library.content.templates.seed.sheetTechR1Dim"),
                  weight: 30,
                  optA: 9,
                  optB: 6,
                  note: t("web.library.content.templates.seed.sheetTechR1Note"),
                },
                {
                  dim: t("web.library.content.templates.seed.sheetTechR2Dim"),
                  weight: 25,
                  optA: 9,
                  optB: 5,
                  note: t("web.library.content.templates.seed.sheetTechR2Note"),
                },
                {
                  dim: t("web.library.content.templates.seed.sheetTechR3Dim"),
                  weight: 15,
                  optA: 6,
                  optB: 9,
                  note: t("web.library.content.templates.seed.sheetTechR3Note"),
                },
                {
                  dim: t("web.library.content.templates.seed.sheetTechR4Dim"),
                  weight: 20,
                  optA: 8,
                  optB: 6,
                  note: t("web.library.content.templates.seed.sheetTechR4Note"),
                },
                {
                  dim: t("web.library.content.templates.seed.sheetTechR5Dim"),
                  weight: 10,
                  optA: 8,
                  optB: 8,
                  note: t("web.library.content.templates.seed.sheetTechR5Note"),
                },
              ],
            ),
          ],
        }),
      ];
    }
    case "sheetTestMatrix": {
      const tab = t("web.library.content.templates.seed.sheetTestTab");
      return [
        jsonWriteItem("structure/base.json", {
          version: 1,
          sheets: [
            toBaseSheet(
              "sheet1",
              tab || title,
              [
                { key: "id", title: t("web.library.content.templates.seed.sheetTestColId"), type: "string" },
                { key: "area", title: t("web.library.content.templates.seed.sheetTestColArea"), type: "string" },
                { key: "scenario", title: t("web.library.content.templates.seed.sheetTestColCase"), type: "string" },
                { key: "layer", title: t("web.library.content.templates.seed.sheetTestColEnv"), type: "string" },
                { key: "team", title: t("web.library.content.templates.seed.sheetTestColOwner"), type: "string" },
                { key: "status", title: t("web.library.content.templates.seed.sheetTestColResult"), type: "string" },
              ],
              [
                {
                  id: "TC-01",
                  area: t("web.library.content.templates.seed.sheetTestR1Area"),
                  scenario: t("web.library.content.templates.seed.sheetTestR1Case"),
                  layer: t("web.library.content.templates.seed.sheetTestR1Env"),
                  team: t("web.library.content.templates.seed.sheetTestR1Owner"),
                  status: t("web.library.content.templates.seed.sheetTestR1Res"),
                },
                {
                  id: "TC-02",
                  area: t("web.library.content.templates.seed.sheetTestR2Area"),
                  scenario: t("web.library.content.templates.seed.sheetTestR2Case"),
                  layer: t("web.library.content.templates.seed.sheetTestR2Env"),
                  team: t("web.library.content.templates.seed.sheetTestR2Owner"),
                  status: t("web.library.content.templates.seed.sheetTestR2Res"),
                },
                {
                  id: "TC-03",
                  area: t("web.library.content.templates.seed.sheetTestR3Area"),
                  scenario: t("web.library.content.templates.seed.sheetTestR3Case"),
                  layer: t("web.library.content.templates.seed.sheetTestR3Env"),
                  team: t("web.library.content.templates.seed.sheetTestR3Owner"),
                  status: t("web.library.content.templates.seed.sheetTestR3Res"),
                },
                {
                  id: "TC-04",
                  area: t("web.library.content.templates.seed.sheetTestR4Area"),
                  scenario: t("web.library.content.templates.seed.sheetTestR4Case"),
                  layer: t("web.library.content.templates.seed.sheetTestR4Env"),
                  team: t("web.library.content.templates.seed.sheetTestR4Owner"),
                  status: t("web.library.content.templates.seed.sheetTestR4Res"),
                },
              ],
            ),
          ],
        }),
      ];
    }
    case "sheetApiInventory": {
      const tab = t("web.library.content.templates.seed.sheetApiTab");
      return [
        jsonWriteItem("structure/base.json", {
          version: 1,
          sheets: [
            toBaseSheet(
              "sheet1",
              tab || title,
              [
                { key: "method", title: t("web.library.content.templates.seed.sheetApiColMethod"), type: "string" },
                { key: "path", title: t("web.library.content.templates.seed.sheetApiColPath"), type: "string" },
                { key: "auth", title: t("web.library.content.templates.seed.sheetApiColAuth"), type: "string" },
                { key: "rate", title: t("web.library.content.templates.seed.sheetApiColRate"), type: "string" },
                { key: "team", title: t("web.library.content.templates.seed.sheetApiColOwner"), type: "string" },
                { key: "stability", title: t("web.library.content.templates.seed.sheetApiColStability"), type: "string" },
              ],
              [
                {
                  method: "GET",
                  path: "/api/v1/slice/board",
                  auth: t("web.library.content.templates.seed.sheetApiR1Auth"),
                  rate: t("web.library.content.templates.seed.sheetApiR1Rate"),
                  team: t("web.library.content.templates.seed.sheetApiR1Owner"),
                  stability: t("web.library.content.templates.seed.sheetApiR1Stab"),
                },
                {
                  method: "POST",
                  path: "/api/v1/note/create",
                  auth: t("web.library.content.templates.seed.sheetApiR2Auth"),
                  rate: t("web.library.content.templates.seed.sheetApiR2Rate"),
                  team: t("web.library.content.templates.seed.sheetApiR2Owner"),
                  stability: t("web.library.content.templates.seed.sheetApiR2Stab"),
                },
                {
                  method: "POST",
                  path: "/api/v1/session/send",
                  auth: t("web.library.content.templates.seed.sheetApiR3Auth"),
                  rate: t("web.library.content.templates.seed.sheetApiR3Rate"),
                  team: t("web.library.content.templates.seed.sheetApiR3Owner"),
                  stability: t("web.library.content.templates.seed.sheetApiR3Stab"),
                },
                {
                  method: "POST",
                  path: "/api/v1/remote/pair/exchange",
                  auth: t("web.library.content.templates.seed.sheetApiR4Auth"),
                  rate: t("web.library.content.templates.seed.sheetApiR4Rate"),
                  team: t("web.library.content.templates.seed.sheetApiR4Owner"),
                  stability: t("web.library.content.templates.seed.sheetApiR4Stab"),
                },
              ],
            ),
          ],
        }),
      ];
    }
  }
}

function buildDashboardFiles(seed: "dashSlo" | "dashDora", title: string): NoteFileWriteItem[] {
  if (seed === "dashSlo") {
    const services = [
      t("web.library.content.templates.seed.dashSloR1"),
      t("web.library.content.templates.seed.dashSloR2"),
      t("web.library.content.templates.seed.dashSloR3"),
      t("web.library.content.templates.seed.dashSloR4"),
    ];
    const blocks: DocBlock[] = [
      { id: "b1", type: "heading", level: 1, text: title },
      {
        id: "b2",
        type: "kpi",
        items: [
          { label: t("web.library.content.templates.seed.dashSloP1"), value: "99.97%" },
          { label: t("web.library.content.templates.seed.dashSloP2"), value: "28 ms" },
          { label: t("web.library.content.templates.seed.dashSloP3"), value: "76%" },
          { label: t("web.library.content.templates.seed.dashSloP4"), value: "3" },
        ],
      },
      {
        id: "b3",
        type: "chart",
        title: t("web.library.content.templates.seed.dashSloP2"),
        kind: "bar",
        labels: services,
        series: [{ name: t("web.library.content.templates.seed.dashSloP99Col"), data: [14, 19, 11, 28] }],
      },
      {
        id: "b4",
        type: "table",
        headers: [
          t("web.library.content.templates.seed.dashSloServiceCol"),
          t("web.library.content.templates.seed.dashSloAvailCol"),
          t("web.library.content.templates.seed.dashSloP99Col"),
          t("web.library.content.templates.seed.dashSloBudgetCol"),
          t("web.library.content.templates.seed.dashSloAlertsCol"),
        ],
        rows: [
          [services[0] ?? "", "99.98%", "14", "92%", "0"],
          [services[1] ?? "", "99.96%", "19", "84%", "1"],
          [services[2] ?? "", "99.99%", "11", "96%", "0"],
          [services[3] ?? "", "99.94%", "28", "76%", "2"],
        ],
      },
    ];
    return [jsonWriteItem("structure/doc.json", { version: 1, blocks })];
  }

  const blocks: DocBlock[] = [
    { id: "b1", type: "heading", level: 1, text: title },
    {
      id: "b2",
      type: "kpi",
      items: [
        { label: t("web.library.content.templates.seed.dashDoraP1"), value: "23.5" },
        { label: t("web.library.content.templates.seed.dashDoraP2"), value: "4.8 h" },
        { label: t("web.library.content.templates.seed.dashDoraP3"), value: "2.7%" },
        { label: t("web.library.content.templates.seed.dashDoraP4"), value: "16 min" },
      ],
    },
    {
      id: "b3",
      type: "chart",
      title: t("web.library.content.templates.seed.dashDoraP1"),
      kind: "bar",
      labels: ["W44", "W45", "W46", "W47"],
      series: [{ name: t("web.library.content.templates.seed.dashDoraDeployCol"), data: [18, 22, 25, 29] }],
    },
    {
      id: "b4",
      type: "table",
      headers: [
        t("web.library.content.templates.seed.dashDoraWeekCol"),
        t("web.library.content.templates.seed.dashDoraDeployCol"),
        t("web.library.content.templates.seed.dashDoraLeadCol"),
        t("web.library.content.templates.seed.dashDoraCfrCol"),
        t("web.library.content.templates.seed.dashDoraMttrCol"),
      ],
      rows: [
        ["W44", "18", "6.4", "4.2%", "22"],
        ["W45", "22", "5.1", "3.1%", "17"],
        ["W46", "25", "4.3", "2.0%", "14"],
        ["W47", "29", "3.6", "1.5%", "11"],
      ],
    },
  ];
  return [jsonWriteItem("structure/doc.json", { version: 1, blocks })];
}

interface SlideSeedSpec {
  readonly id: string;
  readonly file: string;
  readonly layout: "cover" | "content";
  readonly title: string;
  readonly subtitle: string;
  readonly bullets: readonly string[];
  readonly notes: string;
}

function buildSlidesFiles(seed: "slidesArchReview" | "slidesReleaseDemo", title: string): NoteFileWriteItem[] {
  const specs: readonly SlideSeedSpec[] =
    seed === "slidesArchReview"
      ? [
          {
            id: "s01-cover",
            file: "structure/slides/s01-cover.json",
            layout: "cover",
            title,
            subtitle: t("web.library.content.templates.seed.slidesArchS1Sub"),
            bullets: [],
            notes: t("web.library.content.templates.seed.slidesArchS1Notes"),
          },
          {
            id: "s02-context",
            file: "structure/slides/s02-context.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesArchS2Title"),
            subtitle: t("web.library.content.templates.seed.slidesArchS2Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesArchS2B1"),
              t("web.library.content.templates.seed.slidesArchS2B2"),
              t("web.library.content.templates.seed.slidesArchS2B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesArchS2Notes"),
          },
          {
            id: "s03-topology",
            file: "structure/slides/s03-topology.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesArchS3Title"),
            subtitle: t("web.library.content.templates.seed.slidesArchS3Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesArchS3B1"),
              t("web.library.content.templates.seed.slidesArchS3B2"),
              t("web.library.content.templates.seed.slidesArchS3B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesArchS3Notes"),
          },
          {
            id: "s04-tradeoffs",
            file: "structure/slides/s04-tradeoffs.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesArchS4Title"),
            subtitle: t("web.library.content.templates.seed.slidesArchS4Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesArchS4B1"),
              t("web.library.content.templates.seed.slidesArchS4B2"),
              t("web.library.content.templates.seed.slidesArchS4B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesArchS4Notes"),
          },
          {
            id: "s05-rollout",
            file: "structure/slides/s05-rollout.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesArchS5Title"),
            subtitle: t("web.library.content.templates.seed.slidesArchS5Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesArchS5B1"),
              t("web.library.content.templates.seed.slidesArchS5B2"),
              t("web.library.content.templates.seed.slidesArchS5B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesArchS5Notes"),
          },
        ]
      : [
          {
            id: "s01-cover",
            file: "structure/slides/s01-cover.json",
            layout: "cover",
            title,
            subtitle: t("web.library.content.templates.seed.slidesRelS1Sub"),
            bullets: [],
            notes: t("web.library.content.templates.seed.slidesRelS1Notes"),
          },
          {
            id: "s02-problem",
            file: "structure/slides/s02-problem.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesRelS2Title"),
            subtitle: t("web.library.content.templates.seed.slidesRelS2Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesRelS2B1"),
              t("web.library.content.templates.seed.slidesRelS2B2"),
              t("web.library.content.templates.seed.slidesRelS2B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesRelS2Notes"),
          },
          {
            id: "s03-highlights",
            file: "structure/slides/s03-highlights.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesRelS3Title"),
            subtitle: t("web.library.content.templates.seed.slidesRelS3Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesRelS3B1"),
              t("web.library.content.templates.seed.slidesRelS3B2"),
              t("web.library.content.templates.seed.slidesRelS3B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesRelS3Notes"),
          },
          {
            id: "s04-impact",
            file: "structure/slides/s04-impact.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesRelS4Title"),
            subtitle: t("web.library.content.templates.seed.slidesRelS4Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesRelS4B1"),
              t("web.library.content.templates.seed.slidesRelS4B2"),
              t("web.library.content.templates.seed.slidesRelS4B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesRelS4Notes"),
          },
          {
            id: "s05-next",
            file: "structure/slides/s05-next.json",
            layout: "content",
            title: t("web.library.content.templates.seed.slidesRelS5Title"),
            subtitle: t("web.library.content.templates.seed.slidesRelS5Sub"),
            bullets: [
              t("web.library.content.templates.seed.slidesRelS5B1"),
              t("web.library.content.templates.seed.slidesRelS5B2"),
              t("web.library.content.templates.seed.slidesRelS5B3"),
            ],
            notes: t("web.library.content.templates.seed.slidesRelS5Notes"),
          },
        ];

  const blocks: DocBlock[] = [];
  let seq = 0;
  for (const [idx, s] of specs.entries()) {
    if (idx > 0) {
      blocks.push({ id: `pb_${++seq}`, type: "pageBreak", title: s.title, speakerNotes: s.notes });
    }
    blocks.push({ id: `h_${++seq}`, type: "heading", level: idx === 0 ? 1 : 2, text: s.title });
    if (s.subtitle) blocks.push({ id: `p_${++seq}`, type: "prose", text: s.subtitle });
    if (s.bullets.length > 0) blocks.push({ id: `l_${++seq}`, type: "list", ordered: false, items: [...s.bullets] });
  }
  return [jsonWriteItem("structure/doc.json", { version: 1, blocks })];
}

function buildPrototypeFiles(seed: "protoApiPlayground" | "protoComponentLab", title: string): NoteFileWriteItem[] {
  const safeTitle = escapeHtml(title);
  if (seed === "protoApiPlayground") {
    const labels = {
      valid: t("web.library.content.templates.seed.protoApiValid"),
      invalid: t("web.library.content.templates.seed.protoApiInvalid"),
    };
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="shell">
    <header class="head">
      <h1>${escapeHtml(t("web.library.content.templates.seed.protoApiTitle"))}</h1>
      <p class="sub">${escapeHtml(t("web.library.content.templates.seed.protoApiSub"))}</p>
    </header>
    <section class="bar">
      <select id="method" aria-label="HTTP method">
        <option value="POST">POST</option>
        <option value="GET">GET</option>
        <option value="PUT">PUT</option>
        <option value="DELETE">DELETE</option>
      </select>
      <input id="endpoint" type="text" value="/api/v1/resources" aria-label="Endpoint path" />
      <button id="btn-pretty" type="button">${escapeHtml(t("web.library.content.templates.seed.protoApiBtnPretty"))}</button>
      <button id="btn-minify" type="button" class="secondary">${escapeHtml(t("web.library.content.templates.seed.protoApiBtnMinify"))}</button>
      <button id="btn-curl" type="button" class="secondary">${escapeHtml(t("web.library.content.templates.seed.protoApiBtnCopy"))}</button>
    </section>
    <section class="grid">
      <div class="panel">
        <div class="panel-head">
          <span>${escapeHtml(t("web.library.content.templates.seed.protoApiPayloadLabel"))}</span>
          <span id="status" class="status ok">${escapeHtml(labels.valid)}</span>
        </div>
        <textarea id="payload" rows="12" spellcheck="false">{\n  "id": "res_01",\n  "title": "Design RFC",\n  "tags": ["engineering", "v1"],\n  "dryRun": false\n}</textarea>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${escapeHtml(t("web.library.content.templates.seed.protoApiCurlLabel"))}</span></div>
        <pre id="curl-out"></pre>
      </div>
    </section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
    const css = `:root { --bg: #fcfcfb; --card: #ffffff; --ink: #1c1917; --muted: #57534e; --line: #e7e5e4; --accent: #4d7a2a; --ok: #15803d; --err: #b91c1c; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); padding: 24px; }
.shell { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.head h1 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; color: var(--muted); font-size: 13px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; }
select, input, textarea { border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); font: inherit; padding: 8px 10px; }
input { flex: 1; min-width: 200px; font-family: ui-monospace, monospace; font-size: 13px; }
button { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
button.secondary { background: var(--card); color: var(--ink); border-color: var(--line); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.panel { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: var(--muted); }
textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; resize: vertical; }
pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; color: var(--ink); background: var(--bg); padding: 10px; border-radius: 8px; border: 1px solid var(--line); min-height: 180px; }
.status.ok { color: var(--ok); }
.status.err { color: var(--err); }
`;
    const js = `const labels = ${JSON.stringify(labels)};
const methodEl = document.getElementById("method");
const endpointEl = document.getElementById("endpoint");
const payloadEl = document.getElementById("payload");
const statusEl = document.getElementById("status");
const curlEl = document.getElementById("curl-out");

function renderCurl() {
  const method = methodEl.value;
  const path = endpointEl.value.trim() || "/api/v1/resources";
  let valid = true;
  try {
    JSON.parse(payloadEl.value);
    statusEl.textContent = labels.valid;
    statusEl.className = "status ok";
  } catch (err) {
    valid = false;
    statusEl.textContent = labels.invalid + (err instanceof Error ? err.message : String(err));
    statusEl.className = "status err";
  }
  const bodyPart = method === "GET" ? "" : \` \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d '\${payloadEl.value.replaceAll("'", "'\\\\''")}'\`;
  curlEl.textContent = \`curl -X \${method} "http://127.0.0.1:8787\${path}"\${bodyPart}\`;
  return valid;
}

document.getElementById("btn-pretty").addEventListener("click", () => {
  try {
    payloadEl.value = JSON.stringify(JSON.parse(payloadEl.value), null, 2);
  } catch {}
  renderCurl();
});

document.getElementById("btn-minify").addEventListener("click", () => {
  try {
    payloadEl.value = JSON.stringify(JSON.parse(payloadEl.value));
  } catch {}
  renderCurl();
});

document.getElementById("btn-curl").addEventListener("click", renderCurl);
methodEl.addEventListener("change", renderCurl);
endpointEl.addEventListener("input", renderCurl);
payloadEl.addEventListener("input", renderCurl);
renderCurl();
`;
    return [
      jsonWriteItem("structure/doc.json", {
        version: 1,
        blocks: [
          { id: "b1", type: "heading", level: 1, text: title },
          { id: "b2", type: "preview", entry: "structure/index.html", height: 520, title },
        ],
      }),
      textWriteItem("structure/index.html", html, "text/html"),
      textWriteItem("structure/styles.css", css, "text/css"),
      textWriteItem("structure/app.js", js, "application/javascript"),
    ];
  }

  const labels = {
    cardTitle: t("web.library.content.templates.seed.protoCompCardTitle"),
    cardBody: t("web.library.content.templates.seed.protoCompCardBody"),
    loading: t("web.library.content.templates.seed.protoCompLoadingText"),
    empty: t("web.library.content.templates.seed.protoCompEmptyText"),
    error: t("web.library.content.templates.seed.protoCompErrorText"),
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="shell">
    <header class="head">
      <h1>${escapeHtml(t("web.library.content.templates.seed.protoCompTitle"))}</h1>
      <p class="sub">${escapeHtml(t("web.library.content.templates.seed.protoCompSub"))}</p>
    </header>
    <section class="controls">
      <div class="group">
        <span>${escapeHtml(t("web.library.content.templates.seed.protoCompStateLabel"))}</span>
        <button data-state="default" class="active" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompStateDefault"))}</button>
        <button data-state="loading" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompStateLoading"))}</button>
        <button data-state="empty" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompStateEmpty"))}</button>
        <button data-state="error" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompStateError"))}</button>
      </div>
      <div class="group">
        <span>${escapeHtml(t("web.library.content.templates.seed.protoCompThemeLabel"))}</span>
        <button data-theme="light" class="active" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompThemeLight"))}</button>
        <button data-theme="dark" type="button">${escapeHtml(t("web.library.content.templates.seed.protoCompThemeDark"))}</button>
      </div>
      <div class="group">
        <span>${escapeHtml(t("web.library.content.templates.seed.protoCompWidthLabel"))}</span>
        <button data-width="375" type="button">375px</button>
        <button data-width="768" class="active" type="button">768px</button>
        <button data-width="1024" type="button">1024px</button>
      </div>
    </section>
    <section id="stage" class="stage" data-theme="light" style="max-width: 768px;">
      <article id="preview-card" class="card"></article>
    </section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
  const css = `* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917; padding: 24px; }
.shell { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.head h1 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; color: #57534e; font-size: 13px; }
.controls { display: flex; flex-wrap: wrap; gap: 12px; }
.group { display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 6px 10px; font-size: 12px; }
.group span { color: #57534e; font-weight: 600; margin-right: 4px; }
button { border: 1px solid #e7e5e4; background: #fcfcfb; color: #1c1917; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
button.active { background: #4d7a2a; color: #fff; border-color: #4d7a2a; }
.stage { width: 100%; border-radius: 12px; border: 1px solid #d6d3d1; padding: 24px; transition: max-width 150ms ease; }
.stage[data-theme="light"] { background: #fcfcfb; color: #1c1917; }
.stage[data-theme="dark"] { background: #151413; color: #f5f5f4; border-color: #292524; }
.card { border-radius: 10px; padding: 16px; border: 1px solid rgba(120, 113, 108, 0.28); }
.card.error { border-color: #dc2626; background: rgba(220, 38, 38, 0.08); }
.card.muted { opacity: 0.75; }
.card h2 { margin: 0 0 6px; font-size: 16px; }
.card p { margin: 0; font-size: 13px; line-height: 1.5; }
`;
  const js = `const labels = ${JSON.stringify(labels)};
const stage = document.getElementById("stage");
const card = document.getElementById("preview-card");
let state = "default";

function render() {
  card.replaceChildren();
  const h = document.createElement("h2");
  const p = document.createElement("p");
  if (state === "default") {
    card.className = "card";
    h.textContent = labels.cardTitle;
    p.textContent = labels.cardBody;
    card.append(h, p);
  } else if (state === "loading") {
    card.className = "card muted";
    p.textContent = labels.loading;
    card.append(p);
  } else if (state === "empty") {
    card.className = "card muted";
    p.textContent = labels.empty;
    card.append(p);
  } else {
    card.className = "card error";
    p.textContent = labels.error;
    card.append(p);
  }
}

document.querySelectorAll("button[data-state]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state = btn.getAttribute("data-state") || "default";
    document.querySelectorAll("button[data-state]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
});

document.querySelectorAll("button[data-theme]").forEach((btn) => {
  btn.addEventListener("click", () => {
    stage.setAttribute("data-theme", btn.getAttribute("data-theme") || "light");
    document.querySelectorAll("button[data-theme]").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.querySelectorAll("button[data-width]").forEach((btn) => {
  btn.addEventListener("click", () => {
    stage.style.maxWidth = (btn.getAttribute("data-width") || "768") + "px";
    document.querySelectorAll("button[data-width]").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

render();
`;
  return [
    jsonWriteItem("structure/doc.json", {
      version: 1,
      blocks: [
        { id: "b1", type: "heading", level: 1, text: title },
        { id: "b2", type: "preview", entry: "structure/index.html", height: 520, title },
      ],
    }),
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

export function buildDeliverableSeedFiles(seed: DeliverableTemplateSeed, title: string): NoteFileWriteItem[] {
  switch (seed) {
    case "docRfc":
    case "docAdr":
    case "docPostmortem":
    case "docApiSpec":
    case "docRunbook":
    case "docSecurity":
    case "docMigration":
    case "docPerf":
      return buildDocFiles(seed, title);
    case "diagMicroservices":
    case "diagSequence":
    case "diagErd":
    case "diagCicd":
    case "diagStateMachine":
      return buildDiagramFiles(seed, title);
    case "sheetBenchmark":
    case "sheetTechMatrix":
    case "sheetTestMatrix":
    case "sheetApiInventory":
      return buildSheetFiles(seed, title);
    case "dashSlo":
    case "dashDora":
      return buildDashboardFiles(seed, title);
    case "slidesArchReview":
    case "slidesReleaseDemo":
      return buildSlidesFiles(seed, title);
    case "protoApiPlayground":
    case "protoComponentLab":
      return buildPrototypeFiles(seed, title);
    case "protoFocusStudio":
    case "protoSynthPad":
    case "protoParticleLab":
    case "protoTokenCalculator":
    case "protoCssGlassStudio":
    case "protoDeskKanban":
      return buildAppSeedFiles(seed, title);
    case "designWorkspaceUi":
    case "dsPapertrails":
    case "motionLaunchReel":
    case "storyboardProductFilm":
      return buildVisualSeedFiles(seed, title);
  }
}
