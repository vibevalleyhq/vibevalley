import { z } from "zod";

import { defineScenario, flattenLayoutDump, type VdpScenarioContext, type VdpUiBounds } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

const CreatedNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  seq: z.number().int().min(0),
});

const CaretRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const BlockEditorProbeSchema = z.object({
  focusedBlockId: z.string().nullable(),
  activeTestId: z.string().nullable(),
  value: z.string(),
  selection: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .nullable(),
  caretBounds: CaretRectSchema.nullable(),
  caretPageBounds: CaretRectSchema.nullable(),
});

type BlockEditorProbe = z.infer<typeof BlockEditorProbeSchema>;

async function readBounds(v: VdpScenarioContext, testId: string): Promise<VdpUiBounds> {
  const res = await v.query({ testId });
  const node = res.nodes.find((n) => n.bounds !== undefined && n.bounds !== null);
  if (!node?.bounds) {
    throw new Error(`Expected bounds on "${testId}" (found ${res.nodes.length} node(s))`);
  }
  return node.bounds;
}

async function readEditorProbe(v: VdpScenarioContext): Promise<BlockEditorProbe> {
  const res = await v.query({ testId: "doc-editor-probe" });
  const rawText = res.nodes[0]?.text;
  if (!rawText) {
    throw new Error("doc-editor-probe returned empty text");
  }
  const parsedJson: unknown = JSON.parse(rawText);
  return BlockEditorProbeSchema.parse(parsedJson);
}

function assertInvariant(cond: boolean, message: string): void {
  if (!cond) {
    throw new Error(`WYSIWYG editor invariant failed: ${message}`);
  }
}

export const docEditorScenario = defineScenario({
  id: "doc-editor",
  description: "WYSIWYG Block Doc caret hit-testing, zero-shift focus, inline rich-link transition, split/merge & cross-block navigation",
  async run(v) {
    const showcase = await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme("light");

    const p1Line1 = "First line checks horizontal left-mid-right click landing without jump.";
    const p1Line2 = "Second line verifies vertical multi-line caret alignment and smooth Up/Down flow.";
    const p1Text = `${p1Line1}\n${p1Line2}`;
    const p2Text = "Alpha Beta Gamma Delta Epsilon Zeta";
    const richText = `关联设计规范 [[note:${showcase.childPageId}|Typography Spec]] 与工单 [[issue:${showcase.issueIds[1] ?? showcase.issueIds[0]}|#2 Note Polish]] 保持零偏移切换。`;

    const editorNote = await v.rpc(
      "note.create",
      {
        title: "WYSIWYG 光标精度与丝滑编辑验收",
        noteType: "doc",
        sortOrder: 5,
        content: JSON.stringify(
          {
            version: 1,
            blocks: [
              { id: "ed_h1", type: "heading", level: 1, text: "WYSIWYG Caret Precision & Smooth Editing" },
              { id: "ed_p1", type: "prose", text: p1Text },
              { id: "ed_p2", type: "prose", text: p2Text },
              { id: "ed_md", type: "prose", text: "Inline stability baseline" },
              {
                id: "ed_wrap",
                type: "prose",
                text: "crates/server/src/note/collab/presence_Synchronization_Long_Unspaced_Path_Token_Soft_Wrap_Check_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
              },
              { id: "ed_rich", type: "prose", text: richText },
              { id: "ed_list", type: "list", ordered: false, items: ["列表首项支持回车拆行", "列表次项支持上下方向键流转"] },
              { id: "ed_todo", type: "todo", checked: false, text: "待办块保持焦点与零跳动编辑" },
            ],
          },
          null,
          2,
        ),
      },
      CreatedNoteSchema,
    );

    await v.nav(`/notes/${editorNote.id}`);
    await v.waitRoute(`/notes/${editorNote.id}`);
    await v.wait("note-block-doc-view");
    await v.wait("doc-block-input-ed_p1");
    await v.settle(120);

    // 1. Measure resting block bounds BEFORE any focus/click.
    const preP1 = await readBounds(v, "doc-block-input-ed_p1");
    const preP2 = await readBounds(v, "doc-block-input-ed_p2");
    const preRich = await readBounds(v, "doc-prose-rich-ed_rich");

    // 2. Click Left, Middle, Right on Line 1 of ed_p1 and verify 0px layout jump + monotonic caret landing.
    const line1Y = Math.round(preP1.y + 12);
    const leftClickX = Math.round(preP1.x + 24);
    const midClickX = Math.round(preP1.x + 190);
    const rightClickX = Math.round(preP1.x + 360);

    await v.click(leftClickX, line1Y);
    await v.settle(80);
    const barOnCaret = await v.query({ testId: "doc-format-bar-ed_p1" });
    assertInvariant(
      barOnCaret.nodes.length === 0,
      `expected selection-only bubbleMenu to stay hidden on empty caret click, found ${barOnCaret.nodes.length} bar(s)`,
    );

    const postP1 = await readBounds(v, "doc-block-input-ed_p1");
    const postP2 = await readBounds(v, "doc-block-input-ed_p2");
    assertInvariant(
      Math.abs(postP1.x - preP1.x) <= 1 && Math.abs(postP1.y - preP1.y) <= 1,
      `ed_p1 shifted on focus: pre=(${preP1.x},${preP1.y}) post=(${postP1.x},${postP1.y})`,
    );
    assertInvariant(
      Math.abs(postP2.x - preP2.x) <= 1 && Math.abs(postP2.y - preP2.y) <= 1,
      `ed_p2 shifted when ed_p1 format bar opened: pre=(${preP2.x},${preP2.y}) post=(${postP2.x},${postP2.y})`,
    );

    const leftProbe = await readEditorProbe(v);
    assertInvariant(
      leftProbe.focusedBlockId === "ed_p1" && leftProbe.selection !== null,
      `expected ed_p1 focus on left click, got ${JSON.stringify(leftProbe)}`,
    );

    await v.click(midClickX, line1Y);
    await v.settle(60);
    const midProbe = await readEditorProbe(v);

    await v.click(rightClickX, line1Y);
    await v.settle(60);
    const rightProbe = await readEditorProbe(v);

    assertInvariant(
      leftProbe.selection !== null &&
        midProbe.selection !== null &&
        rightProbe.selection !== null &&
        leftProbe.selection.start < midProbe.selection.start &&
        midProbe.selection.start < rightProbe.selection.start,
      `expected monotonic line-1 click offsets left < mid < right, got ${leftProbe.selection?.start}, ${midProbe.selection?.start}, ${rightProbe.selection?.start}`,
    );

    if (midProbe.caretPageBounds !== null) {
      const caretCenterY = midProbe.caretPageBounds.y + midProbe.caretPageBounds.height / 2;
      assertInvariant(
        Math.abs(caretCenterY - line1Y) <= 16 && Math.abs(midProbe.caretPageBounds.x - midClickX) <= 24,
        `mid click (${midClickX},${line1Y}) landed far from caretPageBounds ${JSON.stringify(midProbe.caretPageBounds)}`,
      );
    }

    // 3. Click Line 2 of ed_p1 and verify caret lands on Line 2 (no vertical line jump!).
    const line2Y = Math.round(preP1.y + 36);
    const line2ClickX = Math.round(preP1.x + 150);
    await v.click(line2ClickX, line2Y);
    await v.settle(60);
    const line2Probe = await readEditorProbe(v);
    assertInvariant(
      line2Probe.selection !== null && line2Probe.selection.start > p1Line1.length,
      `expected line-2 click offset > ${p1Line1.length}, got ${line2Probe.selection?.start}`,
    );
    if (line2Probe.caretPageBounds !== null) {
      const caretCenterY = line2Probe.caretPageBounds.y + line2Probe.caretPageBounds.height / 2;
      assertInvariant(
        Math.abs(caretCenterY - line2Y) <= 16,
        `line-2 click Y=${line2Y} landed on wrong line: caretPageBounds=${JSON.stringify(line2Probe.caretPageBounds)}`,
      );
    }

    // 4. Mid-sentence click in ed_p2 -> type text -> Enter split -> Backspace merge.
    await v.click(Math.round(preP2.x + 120), Math.round(preP2.y + 12));
    await v.settle(60);
    const p2ClickProbe = await readEditorProbe(v);
    assertInvariant(
      p2ClickProbe.focusedBlockId === "ed_p2" &&
        p2ClickProbe.selection !== null &&
        p2ClickProbe.selection.start > 0 &&
        p2ClickProbe.selection.start < p2Text.length,
      `expected mid-sentence caret inside ed_p2, got ${JSON.stringify(p2ClickProbe)}`,
    );
    const insAt = p2ClickProbe.selection!.start;

    await v.type("[OK]");
    await v.settle(80);
    const p2TypedProbe = await readEditorProbe(v);
    const expectedTyped = `${p2Text.slice(0, insAt)}[OK]${p2Text.slice(insAt)}`;
    assertInvariant(p2TypedProbe.value === expectedTyped, `mid-sentence typing mismatch: expected "${expectedTyped}", got "${p2TypedProbe.value}"`);
    assertInvariant(p2TypedProbe.selection?.start === insAt + 4, `caret after typing should be ${insAt + 4}, got ${p2TypedProbe.selection?.start}`);

    // Split block at caret with Enter
    await v.key("enter");
    await v.settle(100);
    const splitProbe = await readEditorProbe(v);
    assertInvariant(
      splitProbe.focusedBlockId !== null && splitProbe.focusedBlockId !== "ed_p2",
      `expected Enter to focus newly split block, got ${JSON.stringify(splitProbe)}`,
    );
    assertInvariant(
      splitProbe.value === p2Text.slice(insAt) && splitProbe.selection?.start === 0,
      `expected split tail "${p2Text.slice(insAt)}" with caret=0, got value="${splitProbe.value}" sel=${JSON.stringify(splitProbe.selection)}`,
    );

    await v.assertClean("doc-editor-split-light");
    await v.shot("01-doc-editor-split-light", { label: "Doc Editor Mid-Sentence Split & Floating Format Bar (Light)" });

    // Merge split block backward with Backspace at caret 0
    await v.key("backspace");
    await v.settle(100);
    const mergedProbe = await readEditorProbe(v);
    assertInvariant(mergedProbe.focusedBlockId === "ed_p2", `expected Backspace at 0 to merge back into ed_p2, got ${mergedProbe.focusedBlockId}`);
    assertInvariant(
      mergedProbe.value === expectedTyped && mergedProbe.selection?.start === insAt + 4,
      `expected lossless merge "${expectedTyped}" at caret ${insAt + 4}, got value="${mergedProbe.value}" sel=${JSON.stringify(mergedProbe.selection)}`,
    );

    // 5. Cross-block ArrowUp / ArrowDown navigation.
    await v.key("up");
    await v.settle(80);
    const upProbe = await readEditorProbe(v);
    assertInvariant(
      upProbe.focusedBlockId === "ed_p1" && upProbe.selection?.start === p1Text.length,
      `expected ArrowUp from ed_p2 to focus end of ed_p1 (${p1Text.length}), got ${JSON.stringify(upProbe)}`,
    );

    await v.key("down");
    await v.settle(80);
    const downProbe = await readEditorProbe(v);
    assertInvariant(
      downProbe.focusedBlockId === "ed_p2" && downProbe.selection?.start === 0,
      `expected ArrowDown from end of ed_p1 to focus start of ed_p2 (0), got ${JSON.stringify(downProbe)}`,
    );

    // 6. Click unfocused InlineRichText block (ed_rich) -> verify 0px box shift when switching to Input.
    const richBeforeClick = await readBounds(v, "doc-prose-rich-ed_rich");
    assertInvariant(
      Math.abs(richBeforeClick.x - preRich.x) <= 1 && Math.abs(richBeforeClick.y - preRich.y) <= 1,
      `ed_rich drifted after split+merge roundtrip: initial=(${preRich.x},${preRich.y}) current=(${richBeforeClick.x},${richBeforeClick.y})`,
    );
    await v.click(Math.round(richBeforeClick.x + 36), Math.round(richBeforeClick.y + 12));
    await v.wait("doc-block-input-ed_rich");
    await v.settle(80);
    const richInputBounds = await readBounds(v, "doc-block-input-ed_rich");
    assertInvariant(
      Math.abs(richInputBounds.x - richBeforeClick.x) <= 1 && Math.abs(richInputBounds.y - richBeforeClick.y) <= 1,
      `InlineRichText -> Input shifted position: view=(${richBeforeClick.x},${richBeforeClick.y}) input=(${richInputBounds.x},${richInputBounds.y})`,
    );

    await v.wait("doc-block-input-ed_wrap");
    const wrapDump = flattenLayoutDump(await v.dumpLayout("workbench"));
    const findNode = (id: string) => [...wrapDump.values()].find((n) => n.id === id);
    const docRootNode = findNode("note-block-doc-view");
    const wrapNode = findNode("doc-block-input-ed_wrap");
    assertInvariant(docRootNode?.bounds !== undefined && wrapNode?.bounds !== undefined, "expected bounds for doc root and ed_wrap");
    assertInvariant(
      (wrapNode!.lineCount ?? 1) >= 2 || wrapNode!.bounds!.height >= 44,
      `expected long unspaced path to wrap onto >=2 lines (lineCount=${wrapNode!.lineCount}, height=${wrapNode!.bounds!.height})`,
    );
    assertInvariant(
      wrapNode!.bounds!.width <= docRootNode!.bounds!.width + 2,
      `ed_wrap overflowed doc width (${wrapNode!.bounds!.width} > ${docRootNode!.bounds!.width})`,
    );

    const mdPre = await readBounds(v, "doc-block-input-ed_md");
    await v.click(Math.round(mdPre.x + 80), Math.round(mdPre.y + 12));
    await v.settle(60);
    await v.key("end");
    await v.settle(40);
    await v.expectInlineStable("inline-edit-zero-shift", { targetId: "doc-block-input-ed_md" }, async () => {
      await v.type(" + ok");
    });
    await v.type(" **bold** ");
    await v.settle(80);
    const mdProbe = await readEditorProbe(v);
    assertInvariant(mdProbe.value.includes("**bold**"), `expected Markdown round-trip **bold**, got "${mdProbe.value}"`);
    const mdPost = await readBounds(v, "doc-block-input-ed_md");
    assertInvariant(
      Math.abs(mdPost.height - mdPre.height) <= 1,
      `expected single-line height preservation after **bold**, pre=${mdPre.height}, post=${mdPost.height}`,
    );

    const list0Bounds = await readBounds(v, "doc-list-item-ed_list-0");
    await v.click(Math.round(list0Bounds.x + 48), Math.round(list0Bounds.y + 12));
    await v.settle(60);
    await v.key("enter");
    await v.wait("doc-list-item-ed_list-2");
    await v.settle(80);
    const listProbe = await readEditorProbe(v);
    assertInvariant(
      listProbe.focusedBlockId === "ed_list" && listProbe.activeTestId === "doc-list-item-ed_list-1" && listProbe.selection?.start === 0,
      `expected Enter in list item 0 to focus list item 1 at caret 0, got ${JSON.stringify(listProbe)}`,
    );

    await v.theme("dark");
    await v.click(midClickX, line1Y);
    await v.settle(60);
    await v.key("cmd-a");
    await v.wait("doc-format-bar-ed_p1");
    await v.assertClean("doc-editor-active-dark");
    await v.shot("02-doc-editor-active-dark", { label: "Doc Editor Zero-Shift Active Selection & Format Bar (Dark)" });
  },
});
