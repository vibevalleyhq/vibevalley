import "../../../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { BaseViewSnapshot, DocBlock, DocView, Issue, Note } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { QueryProvider } from "../../../infra/query";
import { createQueryClient } from "../../../infra/query/cache";
import { BlockDocView } from "../BlockDocView";
import { noteBaseQuery } from "../store";

setLocale("en");

const REVIEW_DOC_ID = noteId("note-review-doc");
const REVIEW_BASE_ID = noteId("note-review-base");
const ISSUE_1_ID = issueId("issue-201");
const ISSUE_2_ID = issueId("issue-202");

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEklEQVR42mP8z8AARAwMjDAGACe8AQX6l3f9AAAAAElFTkSuQmCC";

const SAMPLE_NOTES: readonly Note[] = [
  {
    id: REVIEW_DOC_ID,
    title: "UI Walkthrough Review",
    noteType: "doc",
    sortOrder: 0,
    by: "user",
    byName: "Lucas",
    version: 1,
    seq: 2,
    versions: [],
    at: 1_700_000_000_000,
    updated: 1_700_000_100_000,
  },
  {
    id: REVIEW_BASE_ID,
    title: "UI Review Checklist Base",
    noteType: "base",
    sortOrder: 1,
    by: "user",
    byName: "Lucas",
    version: 1,
    seq: 1,
    versions: [],
    at: 1_700_000_000_000,
    updated: 1_700_000_100_000,
  },
];

const SAMPLE_ISSUES: readonly Issue[] = [
  {
    id: ISSUE_1_ID,
    number: 144,
    title: "Interactive MediaAnnotation overlay",
    description: "Non-destructive image annotation pins",
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
    tags: ["note"],
    createdAt: 1_700_000_000_000,
    stage: { state: "working", acts: [] },
  },
  {
    id: ISSUE_2_ID,
    number: 145,
    title: "BaseEmbed review checklist linkage",
    description: "Bidirectional highlight",
    repo: "vibevalley",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["in_progress"],
    priority: "high",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    tags: ["note"],
    createdAt: 1_700_000_000_000,
    stage: { state: "draft", acts: [] },
  },
];

const SAMPLE_BASE_SNAP: BaseViewSnapshot = {
  noteId: REVIEW_BASE_ID,
  activeSheetId: "sheet_review",
  activeViewId: "v_review_table",
  activeViewKind: "table",
  sheets: [{ id: "sheet_review", name: "Review Checklist", rowCount: 3 }],
  columns: [
    { id: "c_title", name: "Finding", kind: "text", width: 220 },
    {
      id: "c_severity",
      name: "Severity",
      kind: "select",
      width: 96,
      options: [
        { value: "p0", label: "P0", color: "red" },
        { value: "p1", label: "P1", color: "amber" },
        { value: "ux", label: "UX", color: "green" },
      ],
    },
    {
      id: "c_status",
      name: "Status",
      kind: "select",
      width: 96,
      options: [
        { value: "open", label: "Open", color: "amber" },
        { value: "resolved", label: "Resolved", color: "green" },
      ],
    },
    { id: "c_issue", name: "Issue", kind: "issueRef", width: 110 },
  ],
  rows: [
    {
      id: "rev_1",
      annotationRef: { noteId: REVIEW_DOC_ID, blockId: "m_shot", annotationId: "ann_1", number: 1 },
      cells: {
        c_title: { _tag: "text", value: "Sidebar border contrast" },
        c_severity: { _tag: "text", value: "p0" },
        c_status: { _tag: "text", value: "open" },
        c_issue: { _tag: "issueRef", issueId: ISSUE_1_ID },
      },
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "rev_2",
      annotationRef: { noteId: REVIEW_DOC_ID, blockId: "m_shot", annotationId: "ann_2", number: 2 },
      cells: {
        c_title: { _tag: "text", value: "Header button alignment" },
        c_severity: { _tag: "text", value: "p1" },
        c_status: { _tag: "text", value: "open" },
      },
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "rev_3",
      annotationRef: { noteId: REVIEW_DOC_ID, blockId: "m_shot", annotationId: "ann_3", number: 3 },
      cells: {
        c_title: { _tag: "text", value: "Card spacing polish" },
        c_severity: { _tag: "text", value: "ux" },
        c_status: { _tag: "text", value: "resolved" },
      },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  groups: [],
  summaries: [],
  totalRows: 3,
};

const SAMPLE_BLOCKS: readonly DocBlock[] = [
  {
    id: "m_shot",
    type: "media",
    mediaKind: "image",
    src: TINY_PNG,
    caption: "Papertrails Workspace Screenshot",
    annotations: [
      {
        id: "ann_1",
        number: 1,
        rect: { x: 0.08, y: 0.14, w: 0.22, h: 0.28 },
        severity: "p0",
        title: "Sidebar border contrast",
        body: "Use softer border-line token in Dark mode.",
        status: "open",
        issueId: ISSUE_1_ID,
        baseRowId: "rev_1",
        author: "Ada",
      },
      {
        id: "ann_2",
        number: 2,
        rect: { x: 0.42, y: 0.12, w: 0.26, h: 0.22 },
        severity: "p1",
        title: "Header button alignment",
        body: "Keep primary action vertically centered.",
        status: "open",
        baseRowId: "rev_2",
        author: "Lin",
      },
      {
        id: "ann_3",
        number: 3,
        rect: { x: 0.68, y: 0.52, w: 0.2, h: 0.22 },
        severity: "ux",
        title: "Card spacing polish",
        status: "resolved",
        baseRowId: "rev_3",
      },
    ],
  },
  {
    id: "b_review_embed",
    type: "baseEmbed",
    noteId: REVIEW_BASE_ID,
    sheetId: "sheet_review",
    viewId: "v_review_table",
  },
  {
    id: "t_matrix",
    type: "table",
    headers: ["Surface", "Light", "Dark"],
    alignments: ["left", "center", "right"],
    rows: [
      ["Doc", "Pass", "Pass"],
      ["Base", "Pass", "Review"],
    ],
  },
];

const SAMPLE_DOC_VIEW: DocView = {
  noteId: REVIEW_DOC_ID,
  title: "UI Walkthrough Review",
  blocks: [...SAMPLE_BLOCKS],
  slideCount: 1,
  wordCount: 24,
  extractedLinks: [],
};

const queryClient = createQueryClient();
queryClient.setData(noteBaseQuery({ id: REVIEW_BASE_ID, sheetId: "sheet_review", viewId: "v_review_table" }), () => ({ value: SAMPLE_BASE_SNAP }));

function MediaAnnotationBench() {
  const lastEvent = signal("idle");

  return (
    <QueryProvider client={queryClient}>
      <View testID="annot-bench" class="flex-1 bg-page">
        <View class="flex-row items-center gap-3 border-b border-line bg-side px-3 py-1">
          <Text testID="annot-bench-event" class="font-mono text-2xs text-accent">
            {lastEvent()}
          </Text>
        </View>
        <BlockDocView
          note={SAMPLE_NOTES[0]}
          docView={SAMPLE_DOC_VIEW}
          notes={SAMPLE_NOTES}
          issues={SAMPLE_ISSUES}
          onSaveDoc={() => {}}
          onCreateIssueFromBlock={async (title, blockId) => {
            lastEvent.set(`createdIssue:${blockId}:${title}`);
            return ISSUE_2_ID;
          }}
          onOpenNote={(id) => lastEvent.set(`openNote:${id}`)}
          onOpenIssue={(id) => lastEvent.set(`openIssue:${id}`)}
        />
      </View>
    </QueryProvider>
  );
}

mount(() => <MediaAnnotationBench />);
