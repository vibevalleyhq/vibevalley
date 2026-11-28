import type { RichMarkJSON, RichNodeJSON } from "nsh/base";

export type VvRefKind = "note" | "issue" | "issueNumber";

export interface VvRefAttrs {
  readonly kind: VvRefKind;
  readonly id: string;
  readonly label: string;
  readonly embed?: boolean;
  readonly raw?: string;
}

const LINK_WIKI_RE = /^(!?\[\[(?:(note|issue):([^\]|]+?)|#(\d+))(?:\|([^\]]*))?\]\])/u;
const HASH_BOUNDARY_CHAR_RE = /[\s([,:;，。、；：！？（【「『《]/u;
const HASH_ISSUE_BOUNDARY_RE = /(?:^|[\s([,:;/，。、；：！？（【「『《])#(\d+)(?![a-zA-Z0-9_])/gu;

export function isValidHashIssueBoundary(beforeSlice: string, allowAtZero: boolean): boolean {
  if (beforeSlice.length === 0) return allowAtZero;
  const prev = beforeSlice[beforeSlice.length - 1] ?? "";
  if (prev === "/") return /#\d+\/$/u.test(beforeSlice);
  return HASH_BOUNDARY_CHAR_RE.test(prev);
}
const MD_LINK_RE = /^\[([^\]\n]+)\]\(([^)\s\n]+)\)/u;
const MD_CODE_RE = /^`([^`\n]+?)`/u;
const MD_BOLD_RE = /^\*\*([^*\n]+?)\*\*/u;
const MD_STRIKE_RE = /^~~([^~\n]+?)~~/u;
const MD_ITALIC_RE = /^\*([^*\n]+?)\*/u;

function markOrderOf(markType: string): number {
  switch (markType) {
    case "link":
      return 0;
    case "bold":
      return 1;
    case "strike":
      return 2;
    case "italic":
      return 3;
    case "code":
      return 4;
    default:
      return 99;
  }
}

function formatVvRefRaw(attrs: Partial<VvRefAttrs>): string {
  if (typeof attrs.raw === "string" && attrs.raw.length > 0) {
    return attrs.raw;
  }
  const kind = attrs.kind === "note" || attrs.kind === "issue" || attrs.kind === "issueNumber" ? attrs.kind : "issue";
  const id = attrs.id ?? "";
  if (kind === "issueNumber") {
    return `#${id.replace(/^#/u, "")}`;
  }
  const prefix = attrs.embed === true ? "!" : "";
  const label = typeof attrs.label === "string" ? attrs.label.trim() : "";
  const defaultLabel = kind === "issue" ? `#${id}` : id;
  if (label && label !== defaultLabel) {
    return `${prefix}[[${kind}:${id}|${label}]]`;
  }
  return `${prefix}[[${kind}:${id}]]`;
}

export function createVvRefNode(attrs: VvRefAttrs, marks?: readonly RichMarkJSON[]): RichNodeJSON {
  const raw = formatVvRefRaw(attrs);
  const node: RichNodeJSON = {
    type: "vvRef",
    attrs: {
      kind: attrs.kind,
      id: attrs.id,
      label: attrs.label,
      embed: Boolean(attrs.embed),
      raw,
    },
  };
  if (marks && marks.length > 0) {
    node.marks = marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
  }
  return node;
}

function cloneMarks(marks: readonly RichMarkJSON[]): RichMarkJSON[] | undefined {
  if (marks.length === 0) return undefined;
  return marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
}

function appendPlainText(out: RichNodeJSON[], text: string, marks: readonly RichMarkJSON[]): void {
  if (!text) return;
  const cloned = cloneMarks(marks);
  const prev = out.at(-1);
  if (prev !== undefined && prev.type === "text" && typeof prev.text === "string" && marksEqual(prev.marks, cloned)) {
    prev.text = `${prev.text}${text}`;
    return;
  }
  const node: RichNodeJSON = { type: "text", text };
  if (cloned) node.marks = cloned;
  out.push(node);
}

function markKey(m: RichMarkJSON): string {
  if (m.type === "link") {
    const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
    return `link:${href}`;
  }
  return m.type;
}

function sortMarks(marks: readonly RichMarkJSON[] | undefined): RichMarkJSON[] {
  if (!marks || marks.length === 0) return [];
  const seen = new Set<string>();
  const unique: RichMarkJSON[] = [];
  for (const m of marks) {
    const key = markKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }
  unique.sort((a, b) => {
    const oa = markOrderOf(a.type);
    const ob = markOrderOf(b.type);
    if (oa !== ob) return oa - ob;
    return markKey(a).localeCompare(markKey(b));
  });
  return unique;
}

function marksEqual(a: readonly RichMarkJSON[] | undefined, b: readonly RichMarkJSON[] | undefined): boolean {
  const sa = sortMarks(a);
  const sb = sortMarks(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    if (markKey(sa[i]) !== markKey(sb[i])) return false;
  }
  return true;
}

function findNextHashIssueAt(line: string, from: number, isLineStartContext: boolean): { index: number; num: string } | null {
  HASH_ISSUE_BOUNDARY_RE.lastIndex = from;
  for (;;) {
    const m = HASH_ISSUE_BOUNDARY_RE.exec(line);
    if (!m) return null;
    const hashPos = m.index + m[0].lastIndexOf("#");
    if (!isValidHashIssueBoundary(line.slice(0, hashPos), isLineStartContext)) {
      continue;
    }
    return { index: hashPos, num: m[1] };
  }
}

function parseLineSegment(segment: string, outerMarks: readonly RichMarkJSON[], allowLinksAndRefs: boolean, isLineStart: boolean, out: RichNodeJSON[]): void {
  let cursor = 0;
  let plainStart = 0;
  const hasCodeMark = outerMarks.some((m) => m.type === "code");
  const hasLinkMark = outerMarks.some((m) => m.type === "link");

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      appendPlainText(out, segment.slice(plainStart, end), outerMarks);
    }
  };

  while (cursor < segment.length) {
    const rest = segment.slice(cursor);

    if (!hasCodeMark && allowLinksAndRefs) {
      const wiki = LINK_WIKI_RE.exec(rest);
      if (wiki) {
        flushPlain(cursor);
        const embed = wiki[1].startsWith("!");
        const alias = wiki[5]?.trim() ?? "";
        if (wiki[4] !== undefined) {
          const numId = wiki[4];
          out.push(
            createVvRefNode(
              {
                kind: "issueNumber",
                id: numId,
                label: alias || `#${numId}`,
                embed,
                raw: wiki[1],
              },
              outerMarks,
            ),
          );
        } else {
          const kind = wiki[2] === "note" ? "note" : "issue";
          const rawId = (wiki[3] ?? "").trim();
          const id = kind === "issue" ? rawId.replace(/^#/u, "") : rawId;
          out.push(
            createVvRefNode(
              {
                kind,
                id,
                label: alias || (kind === "issue" ? `#${id}` : id),
                embed,
                raw: wiki[1],
              },
              outerMarks,
            ),
          );
        }
        cursor += wiki[1].length;
        plainStart = cursor;
        continue;
      }

      if (rest.startsWith("#")) {
        const atValidBoundary = isValidHashIssueBoundary(segment.slice(0, cursor), isLineStart);
        const hashMatch = atValidBoundary ? /^#(\d+)(?![a-zA-Z0-9_])/u.exec(rest) : null;
        if (hashMatch) {
          flushPlain(cursor);
          const num = hashMatch[1];
          out.push(
            createVvRefNode(
              {
                kind: "issueNumber",
                id: num,
                label: `#${num}`,
                embed: false,
                raw: `#${num}`,
              },
              outerMarks,
            ),
          );
          cursor += hashMatch[0].length;
          plainStart = cursor;
          continue;
        }
      }
    }

    if (!hasCodeMark) {
      const code = MD_CODE_RE.exec(rest);
      if (code) {
        flushPlain(cursor);
        appendPlainText(out, code[1], [...outerMarks, { type: "code" }]);
        cursor += code[0].length;
        plainStart = cursor;
        continue;
      }
    }

    if (!hasCodeMark && allowLinksAndRefs && !hasLinkMark && (cursor === 0 || segment[cursor - 1] !== "[")) {
      const mdLink = MD_LINK_RE.exec(rest);
      if (mdLink) {
        flushPlain(cursor);
        parseLineSegment(mdLink[1], [...outerMarks, { type: "link", attrs: { href: mdLink[2] } }], false, false, out);
        cursor += mdLink[0].length;
        plainStart = cursor;
        continue;
      }
    }

    if (!hasCodeMark && !outerMarks.some((m) => m.type === "bold")) {
      const bold = MD_BOLD_RE.exec(rest);
      if (bold) {
        flushPlain(cursor);
        parseLineSegment(bold[1], [...outerMarks, { type: "bold" }], allowLinksAndRefs, cursor === 0 && isLineStart, out);
        cursor += bold[0].length;
        plainStart = cursor;
        continue;
      }
    }

    if (!hasCodeMark && !outerMarks.some((m) => m.type === "strike")) {
      const strike = MD_STRIKE_RE.exec(rest);
      if (strike) {
        flushPlain(cursor);
        parseLineSegment(strike[1], [...outerMarks, { type: "strike" }], allowLinksAndRefs, cursor === 0 && isLineStart, out);
        cursor += strike[0].length;
        plainStart = cursor;
        continue;
      }
    }

    if (!hasCodeMark && !outerMarks.some((m) => m.type === "italic")) {
      const italic = MD_ITALIC_RE.exec(rest);
      if (italic) {
        flushPlain(cursor);
        parseLineSegment(italic[1], [...outerMarks, { type: "italic" }], allowLinksAndRefs, cursor === 0 && isLineStart, out);
        cursor += italic[0].length;
        plainStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushPlain(segment.length);
  void findNextHashIssueAt;
}

export function markdownToRichNodes(text: string): RichNodeJSON[] {
  if (!text) return [];
  const lines = text.split("\n");
  const out: RichNodeJSON[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      out.push({ type: "hardBreak" });
    }
    const line = lines[i];
    if (line.length > 0) {
      parseLineSegment(line, [], true, true, out);
    }
  }
  return out;
}

export function markdownToRichDoc(text: string): RichNodeJSON {
  const content = markdownToRichNodes(text);
  return {
    type: "doc",
    content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }],
  };
}

function openDelimiter(m: RichMarkJSON): string {
  switch (m.type) {
    case "link":
      return "[";
    case "bold":
      return "**";
    case "strike":
      return "~~";
    case "italic":
      return "*";
    case "code":
      return "`";
    default:
      return "";
  }
}

function closeDelimiter(m: RichMarkJSON): string {
  switch (m.type) {
    case "link": {
      const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
      return `](${href})`;
    }
    case "bold":
      return "**";
    case "strike":
      return "~~";
    case "italic":
      return "*";
    case "code":
      return "`";
    default:
      return "";
  }
}

function richInlineNodesToMarkdown(nodes: readonly RichNodeJSON[] | undefined): string {
  if (!nodes || nodes.length === 0) return "";
  let out = "";
  const openMarks: RichMarkJSON[] = [];

  const closeTo = (keepCount: number) => {
    while (openMarks.length > keepCount) {
      const top = openMarks.pop()!;
      out += closeDelimiter(top);
    }
  };

  const applyMarks = (targetRaw: readonly RichMarkJSON[] | undefined) => {
    const target = sortMarks(targetRaw);
    let prefix = 0;
    while (prefix < openMarks.length && prefix < target.length && markKey(openMarks[prefix]) === markKey(target[prefix])) {
      prefix += 1;
    }
    closeTo(prefix);
    for (let i = prefix; i < target.length; i++) {
      const m = target[i];
      out += openDelimiter(m);
      openMarks.push(m);
    }
  };

  for (const node of nodes) {
    if (node.type === "hardBreak") {
      closeTo(0);
      out += "\n";
      continue;
    }

    if (node.type === "vvRef") {
      const attrs = (node.attrs ?? {}) as Partial<VvRefAttrs>;
      applyMarks(node.marks);
      out += formatVvRefRaw(attrs);
      continue;
    }

    if (node.type === "text") {
      const text = node.text ?? "";
      if (!text) continue;
      if (text.trim().length === 0 && openMarks.length === 0 && (node.marks?.length ?? 0) > 0) {
        out += text;
        continue;
      }
      applyMarks(node.marks);
      out += text;
      continue;
    }

    if (node.content && node.content.length > 0) {
      applyMarks(node.marks);
      out += richInlineNodesToMarkdown(node.content);
    }
  }

  closeTo(0);
  return out;
}

export function splitRichDocToParagraphMarkdowns(doc: RichNodeJSON | undefined): string[] {
  if (!doc) return [""];
  const blocks = doc.content ?? [];
  if (blocks.length === 0) return [""];
  return blocks.map((block) => {
    if (block.type === "hardBreak") return "";
    if (block.type === "text") return block.text ?? "";
    return richInlineNodesToMarkdown(block.content);
  });
}

export function richDocToMarkdown(doc: RichNodeJSON | undefined): string {
  return splitRichDocToParagraphMarkdowns(doc).join("\n");
}
