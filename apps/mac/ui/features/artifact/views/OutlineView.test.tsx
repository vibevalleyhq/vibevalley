import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { responses as artifactResponses } from "../../../fixtures/artifacts";
import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import type { OutlineDocument } from "../html";
import { OUTLINE_INDENT_STEP_PX } from "./outlineEditor";

async function mountOutline(initialDoc: OutlineDocument) {
  let latestDoc = initialDoc;
  let currentContent = JSON.stringify(initialDoc, null, 2);
  let writeCount = 0;

  const fake = fakeHost(scenarios.typical, { route: "/standalone/artifact/art-mine", locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  fake.respond("artifact.file.get", (p: { id: string; path: string }) => {
    if (p.id === "art-mine" && p.path === "structure/outline.json") {
      return {
        artifactId: "art-mine",
        path: "structure/outline.json",
        mime: "application/json",
        encoding: "utf8",
        content: currentContent,
        size: currentContent.length,
        hash: `h_${writeCount}`,
        updatedAt: SCENARIO_NOW,
      };
    }
    const fn = artifactResponses["artifact.file.get"];
    return typeof fn === "function" ? fn(p) : fn;
  });
  fake.respond("artifact.file.write", (p: { id: string; files: { path: string; content: string }[] }) => {
    const entry = p.files.find((f) => f.path === "structure/outline.json");
    if (entry) {
      writeCount += 1;
      currentContent = entry.content;
      latestDoc = JSON.parse(entry.content) as OutlineDocument;
    }
    return {
      artifactId: p.id,
      seq: 10 + writeCount,
      files: p.files.map((f) => ({
        path: f.path,
        mime: "application/json",
        size: f.content.length,
        hash: `h_${writeCount}`,
        updatedAt: SCENARIO_NOW,
      })),
    };
  });

  const app = await open("../../../app/main.tsx", {
    width: 900,
    height: 700,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-outline-view") === 1);

  return {
    app,
    fake,
    getDoc: () => latestDoc,
    getWriteCount: () => writeCount,
  };
}

test("OutlineView preserves exact read/edit/hover geometry for single-line, heading, and wrapped multiline rows", async () => {
  setLocale("en");
  const doc: OutlineDocument = {
    version: 1,
    rootIds: ["h1", "h2"],
    nodes: {
      h1: { id: "h1", text: "Section Heading", kind: "heading", children: ["b1", "t1", "long1"] },
      b1: { id: "b1", text: "Bullet item", kind: "bullet", children: [] },
      t1: { id: "t1", text: "Todo item", kind: "todo", checked: false, children: [] },
      long1: {
        id: "long1",
        text: "This is a long wrapped outline paragraph that spans multiple lines inside the max-w-2xl outline container so clicking it must keep the full wrapped height without collapsing to a single line.",
        kind: "bullet",
        children: [],
      },
      h2: { id: "h2", text: "Second Heading", kind: "heading", children: [] },
    },
  };
  const { app } = await mountOutline(doc);

  const h1RowBefore = app.layout("id:outline-node-h1");
  const h1TextBefore = app.layout("id:outline-text-h1");
  const b1RowBefore = app.layout("id:outline-node-b1");
  const b1TextBefore = app.layout("id:outline-text-b1");
  const t1RowBefore = app.layout("id:outline-node-t1");
  const t1TextBefore = app.layout("id:outline-text-t1");
  const longRowBefore = app.layout("id:outline-node-long1");
  const longTextBefore = app.layout("id:outline-text-long1");
  const h2RowBefore = app.layout("id:outline-node-h2");
  const quickBar = app.layout("id:outline-quick-bar");

  if (
    !h1RowBefore ||
    !h1TextBefore ||
    !b1RowBefore ||
    !b1TextBefore ||
    !t1RowBefore ||
    !t1TextBefore ||
    !longRowBefore ||
    !longTextBefore ||
    !h2RowBefore ||
    !quickBar
  ) {
    throw new Error("expected all outline rows to have computed layout");
  }

  // Unified prefix grid: bullet and todo text share the exact same x-coordinate at the same depth.
  expect(b1TextBefore.x).toBe(t1TextBefore.x);
  expect(b1TextBefore.width).toBe(t1TextBefore.width);
  // Quick-add outer bounds align with the outline list rows.
  expect(quickBar.x).toBe(h1RowBefore.x);
  expect(quickBar.width).toBe(h1RowBefore.width);
  // Second heading gets top rhythm separation from the preceding row.
  expect(h2RowBefore.y - (longRowBefore.y + longRowBefore.height)).toBeGreaterThanOrEqual(8);
  // Wrapped paragraph actually spans multiple lines before edit.
  expect(longTextBefore.height).toBeGreaterThan(b1TextBefore.height * 2);

  // Hovering a row shows floating actions without altering row height or shifting neighbors.
  await app.hover("id:outline-node-b1");
  expect(app.layout("id:outline-node-b1")).toEqual(b1RowBefore);
  expect(app.layout("id:outline-node-t1")).toEqual(t1RowBefore);

  // Editing heading keeps identical row height and text box geometry.
  await app.press("id:outline-text-h1");
  expect(app.layout("id:outline-node-h1")).toEqual(h1RowBefore);
  expect(app.layout("id:outline-node-input-h1")).toEqual(h1TextBefore);

  // Editing single-line bullet keeps identical row height and text box geometry.
  await app.press("id:outline-text-b1");
  expect(app.layout("id:outline-node-b1")).toEqual(b1RowBefore);
  expect(app.layout("id:outline-node-input-b1")).toEqual(b1TextBefore);

  // Editing wrapped multiline paragraph keeps exact multiline height without collapsing.
  await app.press("id:outline-text-long1");
  expect(app.layout("id:outline-node-long1")).toEqual(longRowBefore);
  expect(app.layout("id:outline-node-input-long1")).toEqual(longTextBefore);
});

test("OutlineView aligns depth indentation by OUTLINE_INDENT_STEP_PX across bullet and todo levels", async () => {
  setLocale("en");
  const doc: OutlineDocument = {
    version: 1,
    rootIds: ["r_bullet", "r_todo"],
    nodes: {
      r_bullet: { id: "r_bullet", text: "Root bullet", kind: "bullet", children: ["c_bullet", "c_todo"] },
      c_bullet: { id: "c_bullet", text: "Child bullet", kind: "bullet", children: [] },
      c_todo: { id: "c_todo", text: "Child todo", kind: "todo", checked: false, children: [] },
      r_todo: { id: "r_todo", text: "Root todo", kind: "todo", checked: false, children: [] },
    },
  };
  const { app } = await mountOutline(doc);

  const rootBullet = app.layout("id:outline-text-r_bullet");
  const rootTodo = app.layout("id:outline-text-r_todo");
  const childBullet = app.layout("id:outline-text-c_bullet");
  const childTodo = app.layout("id:outline-text-c_todo");

  if (!rootBullet || !rootTodo || !childBullet || !childTodo) {
    throw new Error("expected depth rows to have computed layout");
  }

  expect(rootBullet.x).toBe(rootTodo.x);
  expect(childBullet.x).toBe(childTodo.x);
  expect(childBullet.x - rootBullet.x).toBe(OUTLINE_INDENT_STEP_PX);
});

test("OutlineView keyboard flows: Enter, Tab/Shift+Tab with collapsed auto-expand, ArrowUp/Down, Alt+Up/Down, Backspace, Escape", async () => {
  setLocale("en");
  const doc: OutlineDocument = {
    version: 1,
    rootIds: ["n1", "n2", "n3"],
    nodes: {
      n1: { id: "n1", text: "First parent", kind: "bullet", children: ["n1a"] },
      n1a: { id: "n1a", text: "Hidden child", kind: "bullet", children: [] },
      n2: { id: "n2", text: "Second item", kind: "todo", checked: false, children: [] },
      n3: { id: "n3", text: "Third item", kind: "bullet", children: [] },
    },
  };
  const { app, fake, getDoc, getWriteCount } = await mountOutline(doc);

  // Collapse n1 so n1a is hidden.
  await app.press("id:outline-collapse-n1");
  expect(app.count("id:outline-node-n1a")).toBe(0);

  // Click n2 to edit, press ArrowUp -> skips hidden n1a and moves directly to n1.
  await app.press("id:outline-text-n2");
  expect(app.count("id:outline-node-input-n2")).toBe(1);
  await app.keyboard.press("up");
  expect(app.count("id:outline-node-input-n1")).toBe(1);
  expect(app.value("id:outline-node-input-n1")).toBe("First parent");

  // ArrowDown moves back to n2.
  await app.keyboard.press("down");
  expect(app.count("id:outline-node-input-n2")).toBe(1);

  // Typing a draft and pressing Tab flushes draft text while indenting under collapsed n1 and auto-expanding n1.
  const writesBeforeTab = getWriteCount();
  await app.type("id:outline-node-input-n2", " draft");
  await app.keyboard.press("tab");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeTab);
  expect(getDoc().nodes.n1?.children).toEqual(["n1a", "n2"]);
  expect(getDoc().nodes.n2?.text).toBe("Second item draft");
  expect(app.count("id:outline-node-n1a")).toBe(1);
  expect(app.count("id:outline-node-input-n2")).toBe(1);
  expect(app.value("id:outline-node-input-n2")).toBe("Second item draft");

  // Shift+Tab outdents n2 back to root while keeping edit focus on n2.
  const writesBeforeOutdent = getWriteCount();
  await app.keyboard.press("shift+tab");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeOutdent);
  expect(getDoc().rootIds).toEqual(["n1", "n2", "n3"]);
  expect(app.count("id:outline-node-input-n2")).toBe(1);

  // Alt+Down reorders n2 below n3 while keeping edit focus on n2.
  const writesBeforeMove = getWriteCount();
  await app.keyboard.press("alt+down");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeMove);
  expect(getDoc().rootIds).toEqual(["n1", "n3", "n2"]);
  expect(app.count("id:outline-node-input-n2")).toBe(1);

  // Enter on todo n2 inserts a new todo sibling after n2 and focuses it immediately.
  const writesBeforeEnter = getWriteCount();
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeEnter);
  const newSiblingId = getDoc().rootIds[3];
  expect(newSiblingId).toBeDefined();
  if (newSiblingId === undefined) throw new Error("expected inserted sibling id");
  expect(getDoc().nodes[newSiblingId]?.kind).toBe("todo");
  await fake.pumpUntil(app, () => app.count(`id:outline-node-input-${newSiblingId}`) === 1);

  // Backspace on a 1-char node erases the character without deleting the node; a second Backspace deletes the empty leaf.
  await app.type(`id:outline-node-input-${newSiblingId}`, "x");
  expect(app.value(`id:outline-node-input-${newSiblingId}`)).toBe("x");
  const writesBeforeFirstBs = getWriteCount();
  await app.keyboard.press("backspace");
  await fake.pump(app);
  expect(app.count(`id:outline-node-input-${newSiblingId}`)).toBe(1);
  expect(app.value(`id:outline-node-input-${newSiblingId}`)).toBe("");
  expect(getWriteCount()).toBe(writesBeforeFirstBs);

  const writesBeforeSecondBs = getWriteCount();
  await app.keyboard.press("backspace");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeSecondBs);
  expect(getDoc().nodes[newSiblingId]).toBeUndefined();
  expect(app.count("id:outline-node-input-n2")).toBe(1);

  // Typing a draft and pressing Escape discards unsaved changes without persisting.
  const writesBeforeEscape = getWriteCount();
  await app.type("id:outline-node-input-n2", " unsaved");
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(app.count("id:outline-node-input-n2")).toBe(0);
  expect(getWriteCount()).toBe(writesBeforeEscape);
  expect(getDoc().nodes.n2?.text).toBe("Second item draft");
});

test("OutlineView Enter on heading inserts a bullet sibling, hover actions work cleanly, and quick-add commits active edits", async () => {
  setLocale("en");
  const doc: OutlineDocument = {
    version: 1,
    rootIds: ["h1", "parent", "task"],
    nodes: {
      h1: { id: "h1", text: "Milestone", kind: "heading", children: [] },
      parent: { id: "parent", text: "", kind: "bullet", children: ["child"] },
      child: { id: "child", text: "Keep me", kind: "bullet", children: [] },
      task: { id: "task", text: "Ship release", kind: "todo", checked: false, children: [] },
    },
  };
  const { app, fake, getDoc, getWriteCount } = await mountOutline(doc);

  // Enter on heading creates a bullet sibling rather than another heading.
  await app.press("id:outline-text-h1");
  const writesBeforeHeadingEnter = getWriteCount();
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeHeadingEnter);
  const afterHeadingId = getDoc().rootIds[1];
  expect(afterHeadingId).toBeDefined();
  if (afterHeadingId === undefined) throw new Error("expected bullet after heading");
  expect(getDoc().nodes[afterHeadingId]?.kind).toBe("bullet");
  await app.keyboard.press("escape");

  // Backspace on empty parent with children must NOT delete the subtree.
  await app.press("id:outline-text-parent");
  expect(app.count("id:outline-node-input-parent")).toBe(1);
  const writesBeforeBs = getWriteCount();
  await app.keyboard.press("backspace");
  await fake.pump(app);
  expect(getWriteCount()).toBe(writesBeforeBs);
  expect(getDoc().nodes.parent).toBeDefined();
  expect(getDoc().nodes.child).toBeDefined();
  await app.keyboard.press("escape");

  // Collapse parent, then hover add-child button expands parent and focuses the new child.
  await app.press("id:outline-collapse-parent");
  expect(app.count("id:outline-node-child")).toBe(0);
  const writesBeforeAddChild = getWriteCount();
  await app.press("id:outline-child-parent");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeAddChild);
  expect(app.count("id:outline-node-child")).toBe(1);
  const addedChildId = getDoc().nodes.parent?.children.at(-1);
  expect(addedChildId).toBeDefined();
  if (addedChildId === undefined) throw new Error("expected newly added child");
  await fake.pumpUntil(app, () => app.count(`id:outline-node-input-${addedChildId}`) === 1);
  await app.keyboard.press("escape");

  // Toggle todo checkbox persists checked=true.
  const writesBeforeToggle = getWriteCount();
  await app.press("id:outline-todo-task");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeToggle);
  expect(getDoc().nodes.task?.checked).toBe(true);

  // Quick-add toggles kind to todo and submits a new root todo item.
  const writesBeforeQuick = getWriteCount();
  await app.press("id:outline-quick-kind");
  await app.type("id:outline-quick-add", "Verify dark theme");
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => getWriteCount() > writesBeforeQuick);
  const addedId = getDoc().rootIds.at(-1);
  expect(addedId).toBeDefined();
  if (addedId === undefined) throw new Error("expected quick-added node");
  expect(getDoc().nodes[addedId]?.kind).toBe("todo");
  expect(getDoc().nodes[addedId]?.text).toBe("Verify dark theme");
});
