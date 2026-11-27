import "../../../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { DocBlock, DocView, Issue, Note, NoteLinkListResult } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { BlockDocView } from "../BlockDocView";

setLocale("en");

const NOTE_MAIN_ID = noteId("note-doc-1");
const NOTE_BASE_ID = noteId("note-base-1");
const NOTE_REF_ID = noteId("note-ref-2");
const ISSUE_1_ID = issueId("issue-101");
const ISSUE_2_ID = issueId("issue-102");

const SAMPLE_NOTES: readonly Note[] = [
  {
    id: NOTE_MAIN_ID,
    title: "Architecture Spec",
    noteType: "doc",
    sortOrder: 0,
    by: "user",
    byName: "Lucas",
    version: 1,
    seq: 4,
    versions: [],
    at: 1_700_000_000_000,
    updated: 1_700_000_100_000,
    cover: {
      path: "",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mime: "image/png",
      seq: 4,
      updatedAt: 1_700_000_100_000,
    },
  },
  {
    id: NOTE_BASE_ID,
    title: "Roadmap Tracker Base",
    noteType: "base",
    sortOrder: 1,
    by: "user",
    byName: "Lucas",
    version: 1,
    seq: 2,
    versions: [],
    at: 1_700_000_000_000,
    updated: 1_700_000_050_000,
    preview: {
      _tag: "base",
      sheetName: "Milestones",
      columns: ["Task", "Status"],
      rows: [["Block Editor", "In Progress"]],
      totalRows: 1,
      totalCols: 2,
    },
  },
  {
    id: NOTE_REF_ID,
    title: "Design Guild Notes",
    noteType: "doc",
    sortOrder: 2,
    by: "user",
    byName: "Lucas",
    version: 1,
    seq: 1,
    versions: [],
    at: 1_700_000_000_000,
    updated: 1_700_000_010_000,
  },
];

const SAMPLE_ISSUES: readonly Issue[] = [
  {
    id: ISSUE_1_ID,
    number: 42,
    title: "Ship 24-block Doc editor",
    description: "Complete all 24 BlockKinds",
    repo: "vibevalley",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "in_progress",
    moves: ["in_review", "done"],
    priority: "high",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    tags: ["ui", "note"],
    createdAt: 1_700_000_000_000,
    stage: { state: "working", acts: [] },
  },
  {
    id: ISSUE_2_ID,
    number: 88,
    title: "Optimize CRDT batcher",
    description: "Batch Loro updates",
    repo: "vibevalley",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["in_progress", "done"],
    priority: "medium",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    tags: ["rust"],
    createdAt: 1_700_000_000_000,
    stage: { state: "draft", acts: [] },
  },
];

const SAMPLE_BLOCKS: readonly DocBlock[] = [
  { id: "b_toc", type: "toc", maxLevel: 2 },
  { id: "b_h1", type: "heading", level: 1, text: "Overview" },
  { id: "b_h3", type: "heading", level: 3, text: "Deep Subsection" },
  { id: "b_prose", type: "prose", text: "See [[note:note-ref-2|Design Guild Notes]] and #42 for details." },
  { id: "b_prose_edit", type: "prose", text: "" },
  { id: "b_prose_slash", type: "prose", text: "" },
  { id: "b_prose_wiki", type: "prose", text: "" },
  { id: "b_list", type: "list", ordered: false, items: ["First bullet", "Second bullet"] },
  { id: "b_todo", type: "todo", checked: false, text: "Verify all 24 blocks" },
  { id: "b_quote", type: "quote", text: "Clarity beats cleverness", attribution: "Design Guild" },
  { id: "b_div", type: "divider" },
  {
    id: "b_toggle",
    type: "toggle",
    title: "Architecture Details",
    text: "Nested block container",
    collapsed: false,
    children: [{ id: "b_toggle_child", type: "prose", text: "Inside toggle child" }],
  },
  { id: "b_callout", type: "callout", tone: "tip", title: "Pro Tip", text: "Type / to insert blocks" },
  { id: "b_code", type: "code", language: "typescript", code: "export const ready = true;" },
  {
    id: "b_table",
    type: "table",
    headers: ["Name", "Role"],
    rows: [["Alice", "Author"]],
    alignments: ["left", "right"],
  },
  { id: "b_bookmark", type: "bookmark", url: "https://vibevalley.dev", title: "VibeValley", description: "AI Workbench" },
  { id: "b_math", type: "math", expression: "E = mc^2", display: true },
  {
    id: "b_cols",
    type: "columns",
    columns: [{ blocks: [{ id: "b_col1_p", type: "prose", text: "Left column" }] }, { blocks: [{ id: "b_col2_p", type: "prose", text: "Right column" }] }],
  },
  { id: "b_pb", type: "pageBreak", title: "Slide 2", speakerNotes: "Discuss metrics next" },
  { id: "b_kpi", type: "kpi", items: [{ label: "Latency", value: "12ms", delta: "-4ms", tone: "ok" }] },
  { id: "b_chart", type: "chart", title: "Velocity", kind: "bar", labels: ["W1", "W2"], series: [{ name: "Points", data: [10, 18] }] },
  { id: "b_diagram", type: "diagram", title: "Pipeline", source: "flowchart LR\n  A --> B" },
  {
    id: "b_compare",
    type: "compare",
    title: "UI Diff",
    beforeLabel: "Before",
    afterLabel: "After",
    beforeAsset: "",
    afterAsset: "",
  },
  { id: "b_media", type: "media", mediaKind: "image", src: "", caption: "Demo shot" },
  { id: "b_preview", type: "preview", entry: "structure/index.html", height: 180, title: "Widget Preview" },
  { id: "b_base", type: "baseEmbed", noteId: NOTE_BASE_ID },
  { id: "b_issue_card", type: "issueCard", issueId: ISSUE_1_ID },
  { id: "b_issue_list", type: "issueList", repo: "vibevalley", limit: 5 },
];

const SAMPLE_DOC_VIEW: DocView = {
  noteId: NOTE_MAIN_ID,
  title: "Architecture Spec",
  blocks: [...SAMPLE_BLOCKS],
  slideCount: 2,
  wordCount: 50,
  extractedLinks: [],
};

const SAMPLE_LINKS: NoteLinkListResult = {
  outgoing: [
    {
      id: "l_out_1",
      sourceKind: "note",
      sourceId: NOTE_MAIN_ID,
      targetKind: "issue",
      targetId: ISSUE_1_ID,
      relation: "embed",
      title: "#42 Ship 24-block Doc editor",
      createdAt: 1_700_000_000_000,
    },
  ],
  backlinks: [
    {
      id: "l_back_1",
      sourceKind: "note",
      sourceId: NOTE_REF_ID,
      targetKind: "note",
      targetId: NOTE_MAIN_ID,
      relation: "link",
      title: "Design Guild Notes",
      noteType: "doc",
      createdAt: 1_700_000_000_000,
    },
  ],
};

const MAIN_NOTE = SAMPLE_NOTES[0];

function BlockDocBench() {
  const saveCount = signal(0);
  const lastSavedBlocks = signal(0);
  const lastEvent = signal("idle");
  const lastIssueEvent = signal("none");

  return (
    <View testID="doc-bench" class="flex-1 bg-page">
      <View class="flex-row items-center gap-3 border-b border-line bg-side px-3 py-1">
        <Text testID="bench-save-count" class="font-mono text-2xs text-ink">{`saves:${saveCount()}`}</Text>
        <Text testID="bench-saved-blocks" class="font-mono text-2xs text-muted">{`savedBlocks:${lastSavedBlocks()}`}</Text>
        <Text testID="bench-event" class="font-mono text-2xs text-accent">
          {lastEvent()}
        </Text>
        <Text testID="bench-issue-event" class="font-mono text-2xs text-ink">
          {lastIssueEvent()}
        </Text>
      </View>
      <BlockDocView
        note={MAIN_NOTE}
        docView={SAMPLE_DOC_VIEW}
        notes={SAMPLE_NOTES}
        issues={SAMPLE_ISSUES}
        links={SAMPLE_LINKS}
        onSaveDoc={(doc) => {
          saveCount.set(saveCount() + 1);
          lastSavedBlocks.set(doc.blocks.length);
        }}
        onRenameTitle={(title) => {
          lastEvent.set(`renamed:${title}`);
        }}
        onCreateIssueFromBlock={async (title, blockId) => {
          lastIssueEvent.set(`createIssue:${blockId}:${title}`);
          return ISSUE_2_ID;
        }}
        onOpenNote={(id) => {
          lastEvent.set(`openNote:${id}`);
        }}
        onOpenIssue={(id) => {
          lastEvent.set(`openIssue:${id}`);
        }}
        onOpenPresenter={() => {
          lastEvent.set("openPresenter");
        }}
      />
    </View>
  );
}

mount(() => <BlockDocBench />);
