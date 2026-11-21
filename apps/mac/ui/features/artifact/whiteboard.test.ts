import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import {
  anchorPoint,
  autoAnchorSides,
  buildArchitectureTemplate,
  buildArrowGeometry,
  buildTimelineTemplate,
  buildWhiteboardHtml,
  buildWhiteboardSvg,
  catmullRomPath,
  createUndoStack,
  resolveStickerSvg,
  samplePolyline,
  simplifyStroke,
  STICKER_IDS,
  WhiteboardElementSchema,
  WhiteboardPresenceSchema,
  type WbElement,
  type WbPresence,
} from "./whiteboard";

const TIMELINE_COPY = {
  title: "Launch Timeline",
  subtitle: "From locked flavor to delivery in 12 days",
  highlight: "12 days",
  day1: "Day 1",
  day2: "Day 2",
  day3: "Day 3",
  day7: "Day 7",
  day8: "Day 8",
  roadCaption: "4 days on the road",
  step1Title: "Lock flavor",
  step1Body: "Milestone v1 locked",
  step2Title: "Build forecast",
  step2Body: "How many pies?",
  step3Title: "Lock pricing",
  step3Body: "What is a pie cost?",
  step4Title: "Place order",
  step4Body: "23 tons",
  step5Title: "Arrive on site",
  step5Body: "In Kansas City",
  step6Title: "Recipe test",
  step6Body: "12 pies, then 500",
  callout: "Allergen label waits on the locked spec",
  userLabel: "Dev",
  orchLabel: "Assistant",
  helperLabel: "Rosa",
};

test("WhiteboardElementSchema & WhiteboardPresenceSchema parse rich editorial and legacy entries", () => {
  const richEntries = [
    { id: "t1", type: "text", variant: "title", x: 72, y: 36, w: 680, h: 48, label: "Timeline" },
    { id: "t2", type: "text", variant: "subtitle", x: 72, y: 84, w: 680, h: 28, label: "Delivery in 12 days", highlight: "12 days" },
    { id: "t3", type: "text", variant: "callout", icon: "!", x: 400, y: 400, w: 220, h: 48, label: "Allergen check" },
    { id: "c1", type: "shape", shape: "card", x: 64, y: 160, w: 170, h: 112, title: "Lock scope", body: "Ready", fill: "sun", sticker: "berry-lock" },
    { id: "c2", type: "shape", shape: "rect", x: 300, y: 160, w: 160, h: 72, label: "Legacy box", fill: "leaf" },
    {
      id: "tl",
      type: "timeline",
      x: 60,
      y: 280,
      w: 720,
      h: 90,
      points: [
        { x: 60, y: 340 },
        { x: 780, y: 290 },
      ],
      milestones: [{ t: 0.1, label: "Day 1", kind: "major" }],
    },
    { id: "a1", type: "arrow", curve: "smooth", style: "dashed", head: "none", from: { id: "c1", side: "s" }, to: { x: 160, y: 320 } },
    {
      id: "p1",
      type: "path",
      points: [
        { x: 10, y: 10 },
        { x: 40, y: 30 },
      ],
      stroke: "#c25140",
      strokeWidth: 3,
    },
    { id: "s1", type: "sticker", sticker: "truck", x: 420, y: 220, w: 96, h: 64 },
    { id: "z1", type: "container", x: 40, y: 120, w: 500, h: 300, title: "Zone" },
    { id: "k1", type: "claim", x: 40, y: 120, w: 200, h: 120, label: "Claimed" },
    { id: "tb1", type: "table", x: 60, y: 480, w: 320, h: 120, headers: ["A", "B"], rows: [["1", "2"]] },
    { id: "svg1", type: "svg", x: 60, y: 480, w: 120, h: 90, svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
    { id: "html1", type: "html", x: 60, y: 480, w: 240, h: 180, html: "<div>hi</div>" },
  ];

  for (const raw of richEntries) {
    const parsed = WhiteboardElementSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  }

  const presence = WhiteboardPresenceSchema.safeParse({ id: "orch", name: "Assistant", color: "coral", x: 520, y: 90 });
  expect(presence.success).toBe(true);
});

test("curve geometry, polyline sampling, Ramer-Douglas-Peucker simplification, and auto anchor sides", () => {
  const pts = [
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 200, y: 50 },
  ];
  const d = catmullRomPath(pts);
  expect(d.startsWith("M 0 100 C ")).toBe(true);
  expect(samplePolyline(pts, 0)).toEqual({ x: 0, y: 100 });
  const mid = samplePolyline(pts, 0.25);
  expect(mid.x).toBeGreaterThan(40);
  expect(mid.y).toBe(100);

  const straightPts = [
    { x: 0, y: 0 },
    { x: 10, y: 0.5 },
    { x: 20, y: 0.2 },
    { x: 30, y: 0 },
    { x: 30, y: 40 },
  ];
  const simplified = simplifyStroke(straightPts, 2);
  expect(simplified.length).toBeLessThan(straightPts.length);
  expect(simplified[0]).toEqual({ x: 0, y: 0 });
  expect(simplified.at(-1)).toEqual({ x: 30, y: 40 });

  const fromEl = { x: 100, y: 100, w: 160, h: 80 };
  const toRight = { x: 400, y: 100, w: 160, h: 80 };
  const toBelow = { x: 100, y: 320, w: 160, h: 80 };
  expect(autoAnchorSides(fromEl, toRight)).toEqual({ fromSide: "e", toSide: "w" });
  expect(autoAnchorSides(fromEl, toBelow)).toEqual({ fromSide: "s", toSide: "n" });

  const byId = new Map([
    ["a", fromEl],
    ["b", toRight],
  ]);
  expect(anchorPoint({ id: "a", side: "e" }, byId, "e")).toEqual({ x: 260, y: 140 });
  const smoothArrow = buildArrowGeometry({ from: { id: "a", side: "e" }, to: { id: "b", side: "w" }, curve: "smooth" }, byId);
  expect(smoothArrow?.d).toContain(" C ");
  const orthoArrow = buildArrowGeometry({ from: { id: "a", side: "e" }, to: { id: "b", side: "w" }, curve: "orthogonal" }, byId);
  expect(orthoArrow?.d).toContain(" L ");
  const straightArrow = buildArrowGeometry({ from: { id: "a", side: "e" }, to: { id: "b", side: "w" }, curve: "straight" }, byId);
  expect(straightArrow?.d).toBe("M 260 140 L 400 140");
});

test("createUndoStack tracks bounded undo/redo history cleanly", () => {
  const stack = createUndoStack(2);
  expect(stack.canUndo()).toBe(false);
  expect(stack.canRedo()).toBe(false);

  stack.push({ undo: [{ op: "delete", path: "elements/1" }], redo: [{ op: "set", path: "elements/1", kind: "json", value: "{}" }] });
  stack.push({ undo: [{ op: "delete", path: "elements/2" }], redo: [{ op: "set", path: "elements/2", kind: "json", value: "{}" }] });
  stack.push({ undo: [{ op: "delete", path: "elements/3" }], redo: [{ op: "set", path: "elements/3", kind: "json", value: "{}" }] });
  expect(stack.canUndo()).toBe(true);

  const s1 = stack.popUndo();
  expect(s1?.undo[0]?.path).toBe("elements/3");
  expect(stack.canRedo()).toBe(true);

  const r1 = stack.popRedo();
  expect(r1?.redo[0]?.path).toBe("elements/3");
  expect(stack.popUndo()?.undo[0]?.path).toBe("elements/3");
  expect(stack.popUndo()?.undo[0]?.path).toBe("elements/2");
  expect(stack.popUndo()).toBeUndefined();
});

test("templates, sticker library, HTML runtime, and Light/Dark SVG export render all rich layers", () => {
  expect(STICKER_IDS.length).toBeGreaterThanOrEqual(16);
  expect(resolveStickerSvg("berry-lock")).toContain("<svg");
  expect(resolveStickerSvg("custom", '<svg viewBox="0 0 10 10"><rect/></svg>')).toContain("<rect/>");

  const writes = buildTimelineTemplate(TIMELINE_COPY);
  const elements: WbElement[] = [];
  const presences: WbPresence[] = [];
  for (const w of writes) {
    if (!w.value) continue;
    const raw = JSON.parse(w.value) as unknown;
    if (w.path.startsWith("elements/")) {
      const parsed = WhiteboardElementSchema.parse(raw);
      elements.push({ ...parsed, rev: 1, raw: w.value });
    } else if (w.path.startsWith("presence/")) {
      presences.push(WhiteboardPresenceSchema.parse(raw));
    }
  }
  elements.push({
    id: "pen-1",
    type: "path",
    points: [
      { x: 100, y: 120 },
      { x: 140, y: 150 },
    ],
    stroke: "#c25140",
    strokeWidth: 3,
    rev: 1,
    raw: "{}",
  });

  const archWrites = buildArchitectureTemplate({
    title: "Architecture",
    subtitle: "Flow in 15 mins",
    highlight: "15 mins",
    zoneCore: "Core",
    zoneStore: "Store",
    clientTitle: "Client",
    clientBody: "Desktop",
    apiTitle: "Gateway",
    apiBody: "SSE",
    coreTitle: "Reducer",
    coreBody: "StateFrame",
    sqliteTitle: "SQLite",
    sqliteBody: "sqlc",
    callout: "Read StateFrame",
  });
  expect(archWrites.length).toBeGreaterThan(8);

  const svgLight = buildWhiteboardSvg(elements, presences, "light");
  expect(svgLight).toContain("Launch Timeline");
  expect(svgLight).toContain("12 days");
  expect(svgLight).toContain("Day 1");
  expect(svgLight).toContain("linearGradient");
  expect(svgLight).toContain("Lock flavor");
  expect(svgLight).toContain("Assistant");
  expect(svgLight).toContain("#fcfcfb");

  const svgDark = buildWhiteboardSvg(elements, presences, "dark");
  expect(svgDark).toContain("#151413");
  expect(svgDark).toContain("Launch Timeline");

  const html = buildWhiteboardHtml("light", {
    emptyHint: "Empty",
    doubleClickEdit: "Edit",
    chatWithOrchestrator: "Chat with orchestrator",
    templateTimeline: "Timeline",
    templateArchitecture: "Architecture",
    select: "Select",
    pan: "Pan",
    text: "Text",
    container: "Frame",
    sticky: "Card",
    pen: "Pen",
    rect: "Shape",
    sticker: "Sticker",
    arrow: "Arrow",
    timeline: "Timeline",
  });
  expect(html).toContain('id="wb-dock"');
  expect(html).toContain("Chat with orchestrator");
  expect(html).toContain('id="wb-sticker-pop"');
});
