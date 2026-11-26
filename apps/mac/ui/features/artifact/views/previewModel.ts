import themeTokens from "../../../design/theme.json";
import type { OutlineDocument, OutlineNode } from "../html";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function asRecordArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord);
}

export interface DashboardDataset {
  readonly path: string;
  readonly name: string;
  readonly schema: readonly { readonly name: string; readonly label: string; readonly type: string }[];
  readonly rows: readonly Record<string, unknown>[];
  readonly cols: readonly string[];
}

export interface DashboardKpiResult {
  readonly formatted: string;
  readonly raw: number | undefined;
  readonly agg: string;
}

export function computeDashboardKpi(panel: Record<string, unknown>, datasetsByPath: ReadonlyMap<string, DashboardDataset>): DashboardKpiResult {
  const source = isRecord(panel.source) ? panel.source : undefined;
  const datasetPath = asString(source?.dataset);
  const field = asString(source?.field);
  const agg = asString(source?.agg, "avg");
  const format = asString(panel.format, "number");
  const dataset = datasetPath ? datasetsByPath.get(datasetPath) : [...datasetsByPath.values()][0];
  if (!dataset || !field) {
    return { formatted: "—", raw: undefined, agg };
  }
  if (agg === "count") {
    const count = dataset.rows.length;
    return { formatted: String(count), raw: count, agg };
  }
  const nums: number[] = [];
  for (const row of dataset.rows) {
    const val = row[field];
    if (typeof val === "number" && Number.isFinite(val)) nums.push(val);
    else if (typeof val === "string") {
      const parsed = Number(val);
      if (Number.isFinite(parsed) && val.trim() !== "") nums.push(parsed);
    }
  }
  if (nums.length === 0) {
    return { formatted: "—", raw: undefined, agg };
  }
  let raw: number;
  switch (agg) {
    case "sum":
      raw = nums.reduce((acc, n) => acc + n, 0);
      break;
    case "min":
      raw = Math.min(...nums);
      break;
    case "max":
      raw = Math.max(...nums);
      break;
    case "last":
      raw = nums[nums.length - 1] ?? 0;
      break;
    default:
      raw = nums.reduce((acc, n) => acc + n, 0) / nums.length;
      break;
  }
  const rounded = Math.round(raw * 100) / 100;
  const numText = Number.isInteger(rounded) ? rounded.toLocaleString("en-US") : rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (format === "percent") {
    return { formatted: `${numText}%`, raw, agg };
  }
  if (format === "currency") {
    return { formatted: `$${numText}`, raw, agg };
  }
  return { formatted: numText, raw, agg };
}

export interface DiagramModel {
  readonly title: string;
  readonly kind: string;
  readonly direction: string;
  readonly nodes: readonly { readonly id: string; readonly label: string; readonly kind: string }[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string; readonly label: string }[];
}

function sanitizeMermaidId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/gu, "_");
  if (!cleaned) return fallback;
  return /^[0-9]/u.test(cleaned) ? `n_${cleaned}` : cleaned;
}

function escapeMermaidText(raw: string): string {
  return raw.replaceAll('"', "'").replaceAll("\n", " ").trim();
}

export function diagramToMermaid(data: DiagramModel): string {
  if (data.nodes.length === 0) return "";
  const idMap = new Map<string, string>();
  data.nodes.forEach((n, idx) => {
    idMap.set(n.id, sanitizeMermaidId(n.id, `n${idx + 1}`));
  });
  const resolveId = (raw: string) => idMap.get(raw) ?? sanitizeMermaidId(raw, "node");

  if (data.kind === "sequence") {
    const lines = ["sequenceDiagram"];
    for (const n of data.nodes) {
      lines.push(`  participant ${resolveId(n.id)} as ${escapeMermaidText(n.label || n.id)}`);
    }
    for (const e of data.edges) {
      if (!e.from || !e.to) continue;
      const msg = escapeMermaidText(e.label) || "call";
      lines.push(`  ${resolveId(e.from)}->>${resolveId(e.to)}: ${msg}`);
    }
    return lines.join("\n");
  }

  if (data.kind === "state-machine") {
    const lines = ["stateDiagram-v2"];
    for (const n of data.nodes) {
      lines.push(`  state "${escapeMermaidText(n.label || n.id)}" as ${resolveId(n.id)}`);
    }
    for (const e of data.edges) {
      if (!e.from || !e.to) continue;
      const lbl = escapeMermaidText(e.label);
      lines.push(lbl ? `  ${resolveId(e.from)} --> ${resolveId(e.to)} : ${lbl}` : `  ${resolveId(e.from)} --> ${resolveId(e.to)}`);
    }
    return lines.join("\n");
  }

  const dir = data.direction === "TB" || data.direction === "TD" || data.direction === "RL" || data.direction === "BT" ? data.direction : "LR";
  const lines = [`flowchart ${dir}`];
  for (const n of data.nodes) {
    const id = resolveId(n.id);
    const label = escapeMermaidText(n.label || n.id);
    switch (n.kind) {
      case "database":
      case "table":
        lines.push(`  ${id}[("${label}")]`);
        break;
      case "queue":
      case "stream":
        lines.push(`  ${id}(["${label}"])`);
        break;
      case "gateway":
      case "decision":
        lines.push(`  ${id}{"${label}"}`);
        break;
      default:
        lines.push(`  ${id}["${label}"]`);
        break;
    }
  }
  for (const e of data.edges) {
    if (!e.from || !e.to) continue;
    const lbl = escapeMermaidText(e.label);
    lines.push(lbl ? `  ${resolveId(e.from)} -->|"${lbl}"| ${resolveId(e.to)}` : `  ${resolveId(e.from)} --> ${resolveId(e.to)}`);
  }
  return lines.join("\n");
}

export interface FlatOutlineRow {
  readonly node: OutlineNode;
  readonly depth: number;
  readonly parentId: string | undefined;
  readonly hasChildren: boolean;
}

export function parseOutlineDoc(raw: string | undefined): OutlineDocument {
  const obj = parseJsonObject(raw);
  if (!obj) return { version: 1, rootIds: [], nodes: {} };
  const rootIds = Array.isArray(obj.rootIds) ? obj.rootIds.filter((x): x is string => typeof x === "string") : [];
  const rawNodes = isRecord(obj.nodes) ? obj.nodes : {};
  const nodes: Record<string, OutlineNode> = {};
  for (const [id, val] of Object.entries(rawNodes)) {
    if (!isRecord(val)) continue;
    const rawKind = val.kind;
    const kind: OutlineNode["kind"] = rawKind === "heading" || rawKind === "todo" ? rawKind : "bullet";
    const children = Array.isArray(val.children) ? val.children.filter((x): x is string => typeof x === "string") : [];
    nodes[id] = {
      id: asString(val.id, id),
      text: asString(val.text),
      kind,
      ...(typeof val.checked === "boolean" ? { checked: val.checked } : {}),
      children,
    };
  }
  return { version: asNumber(obj.version, 1), rootIds, nodes };
}

export function flattenOutline(doc: OutlineDocument, collapsed?: ReadonlySet<string>): FlatOutlineRow[] {
  const out: FlatOutlineRow[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number, parentId: string | undefined) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (!Object.hasOwn(doc.nodes, id)) return;
    const node = doc.nodes[id];
    const validChildren = node.children.filter((c) => Object.hasOwn(doc.nodes, c));
    out.push({ node, depth, parentId, hasChildren: validChildren.length > 0 });
    if (collapsed?.has(id) === true) return;
    for (const child of validChildren) walk(child, depth + 1, id);
  };
  for (const id of doc.rootIds) walk(id, 0, undefined);
  return out;
}

export function countOutlineTodos(doc: OutlineDocument): { readonly done: number; readonly total: number } {
  let done = 0;
  let total = 0;
  for (const row of flattenOutline(doc)) {
    if (row.node.kind === "todo") {
      total += 1;
      if (row.node.checked === true) done += 1;
    }
  }
  return { done, total };
}

export function updateOutlineText(doc: OutlineDocument, nodeId: string, text: string): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const node = doc.nodes[nodeId];
  return { ...doc, nodes: { ...doc.nodes, [nodeId]: { ...node, text } } };
}

export function toggleOutlineTodo(doc: OutlineDocument, nodeId: string): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const node = doc.nodes[nodeId];
  return { ...doc, nodes: { ...doc.nodes, [nodeId]: { ...node, checked: node.checked !== true } } };
}

export function cycleOutlineKind(doc: OutlineDocument, nodeId: string): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const node = doc.nodes[nodeId];
  const nextKind: OutlineNode["kind"] = node.kind === "heading" ? "bullet" : node.kind === "bullet" ? "todo" : "heading";
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      [nodeId]: {
        id: node.id,
        text: node.text,
        kind: nextKind,
        children: node.children,
        ...(nextKind === "todo" ? { checked: node.checked === true } : {}),
      },
    },
  };
}

export function addOutlineRootItem(doc: OutlineDocument, id: string, text: string, kind: OutlineNode["kind"] = "bullet"): OutlineDocument {
  return {
    ...doc,
    rootIds: [...doc.rootIds, id],
    nodes: {
      ...doc.nodes,
      [id]: { id, text, kind, ...(kind === "todo" ? { checked: false } : {}), children: [] },
    },
  };
}

function findParentOf(doc: OutlineDocument, targetId: string): { readonly parentId: string | undefined; readonly siblings: readonly string[] } | undefined {
  if (doc.rootIds.includes(targetId)) {
    return { parentId: undefined, siblings: doc.rootIds };
  }
  for (const node of Object.values(doc.nodes)) {
    if (node.children.includes(targetId)) {
      return { parentId: node.id, siblings: node.children };
    }
  }
  return undefined;
}

export function addOutlineSibling(doc: OutlineDocument, afterId: string, newId: string, text = ""): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, afterId)) return addOutlineRootItem(doc, newId, text, "bullet");
  const afterNode = doc.nodes[afterId];
  const kind: OutlineNode["kind"] = afterNode.kind === "todo" ? "todo" : "bullet";
  const loc = findParentOf(doc, afterId);
  if (!loc) return addOutlineRootItem(doc, newId, text, kind);
  const idx = loc.siblings.indexOf(afterId);
  const nextSiblings = [...loc.siblings.slice(0, idx + 1), newId, ...loc.siblings.slice(idx + 1)];
  const nextNodes: Record<string, OutlineNode> = {
    ...doc.nodes,
    [newId]: { id: newId, text, kind, ...(kind === "todo" ? { checked: false } : {}), children: [] },
  };
  if (loc.parentId === undefined) {
    return { ...doc, rootIds: nextSiblings, nodes: nextNodes };
  }
  if (!Object.hasOwn(doc.nodes, loc.parentId)) return doc;
  const parent = doc.nodes[loc.parentId];
  nextNodes[loc.parentId] = { ...parent, children: nextSiblings };
  return { ...doc, nodes: nextNodes };
}

export function addOutlineChild(doc: OutlineDocument, parentId: string, newId: string, text = ""): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, parentId)) return doc;
  const parent = doc.nodes[parentId];
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      [parentId]: { ...parent, children: [...parent.children, newId] },
      [newId]: { id: newId, text, kind: "bullet", children: [] },
    },
  };
}

export function indentOutlineNode(doc: OutlineDocument, nodeId: string): OutlineDocument {
  const loc = findParentOf(doc, nodeId);
  if (!loc) return doc;
  const idx = loc.siblings.indexOf(nodeId);
  if (idx <= 0) return doc;
  const prevSiblingId = loc.siblings[idx - 1];
  if (prevSiblingId === undefined || !Object.hasOwn(doc.nodes, prevSiblingId)) return doc;
  const prevSibling = doc.nodes[prevSiblingId];
  const remaining = loc.siblings.filter((id) => id !== nodeId);
  const nextNodes: Record<string, OutlineNode> = {
    ...doc.nodes,
    [prevSiblingId]: { ...prevSibling, children: [...prevSibling.children, nodeId] },
  };
  if (loc.parentId === undefined) {
    return { ...doc, rootIds: remaining, nodes: nextNodes };
  }
  if (!Object.hasOwn(doc.nodes, loc.parentId)) return doc;
  const parent = doc.nodes[loc.parentId];
  nextNodes[loc.parentId] = { ...parent, children: remaining };
  return { ...doc, nodes: nextNodes };
}

export function outdentOutlineNode(doc: OutlineDocument, nodeId: string): OutlineDocument {
  const loc = findParentOf(doc, nodeId);
  if (!loc || loc.parentId === undefined) return doc;
  const grandLoc = findParentOf(doc, loc.parentId);
  if (!grandLoc) return doc;
  if (!Object.hasOwn(doc.nodes, loc.parentId)) return doc;
  const parent = doc.nodes[loc.parentId];
  const parentIdx = grandLoc.siblings.indexOf(loc.parentId);
  const nextParentChildren = parent.children.filter((id) => id !== nodeId);
  const nextGrandSiblings = [...grandLoc.siblings.slice(0, parentIdx + 1), nodeId, ...grandLoc.siblings.slice(parentIdx + 1)];
  const nextNodes: Record<string, OutlineNode> = {
    ...doc.nodes,
    [loc.parentId]: { ...parent, children: nextParentChildren },
  };
  if (grandLoc.parentId === undefined) {
    return { ...doc, rootIds: nextGrandSiblings, nodes: nextNodes };
  }
  if (!Object.hasOwn(doc.nodes, grandLoc.parentId)) return doc;
  const grand = doc.nodes[grandLoc.parentId];
  nextNodes[grandLoc.parentId] = { ...grand, children: nextGrandSiblings };
  return { ...doc, nodes: nextNodes };
}

export function deleteOutlineNode(doc: OutlineDocument, nodeId: string): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const toRemove = new Set<string>();
  const collect = (id: string) => {
    if (toRemove.has(id) || !Object.hasOwn(doc.nodes, id)) return;
    toRemove.add(id);
    for (const c of doc.nodes[id].children) collect(c);
  };
  collect(nodeId);
  const nextNodes: Record<string, OutlineNode> = {};
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (toRemove.has(id)) continue;
    nextNodes[id] = { ...node, children: node.children.filter((c) => !toRemove.has(c)) };
  }
  return {
    ...doc,
    rootIds: doc.rootIds.filter((id) => !toRemove.has(id)),
    nodes: nextNodes,
  };
}

function readNumericCell(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

const TEMPORAL_COL_RE = /(?:date|week|day|month|year|quarter|sprint|period|time|hour|min)/iu;

/** Builds a `VvChart` JSON specification for a dashboard dataset when >= 2 rows and >= 1 numeric column exist. */
export function buildDashboardChartSpec(dataset: DashboardDataset): string | undefined {
  if (dataset.rows.length < 2) return undefined;
  const schemaByName = new Map(dataset.schema.map((s) => [s.name, s]));
  const cols = dataset.cols;
  if (cols.length === 0) return undefined;

  const numericCols: string[] = [];
  let labelCol: string | undefined;

  for (const col of cols) {
    const schemaEntry = schemaByName.get(col);
    if (schemaEntry?.type === "number") {
      numericCols.push(col);
      continue;
    }
    const sample = dataset.rows.map((r) => readNumericCell(r[col])).filter((n) => n !== undefined);
    if (schemaEntry === undefined && sample.length === dataset.rows.length && sample.length > 0) {
      numericCols.push(col);
    } else {
      labelCol ??= col;
    }
  }

  if (numericCols.length === 0) return undefined;
  const pickedNumeric = numericCols.slice(0, 3);
  const categories = dataset.rows.map((row, idx) => {
    if (labelCol !== undefined) {
      const raw = row[labelCol];
      if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
      if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    }
    return `#${idx + 1}`;
  });

  const series = pickedNumeric.map((col) => {
    const label = schemaByName.get(col)?.label ?? col;
    return {
      name: label,
      data: dataset.rows.map((row) => readNumericCell(row[col]) ?? null),
    };
  });

  const temporal = labelCol !== undefined && TEMPORAL_COL_RE.test(labelCol);
  if (temporal) {
    return JSON.stringify({
      type: "line",
      width: 680,
      height: 260,
      categories,
      series,
      interpolation: "smooth",
      showPoints: true,
    });
  }

  return JSON.stringify({
    type: "bar",
    width: 680,
    height: 260,
    categories,
    series,
    cornerRadius: 4,
  });
}

/** Computes numeric column totals across filtered rows of a sheet. */
export function computeSheetNumericTotals(
  columns: readonly { readonly key: string; readonly title: string; readonly type: string }[],
  rows: readonly Record<string, unknown>[],
): ReadonlyMap<string, string> {
  const totals = new Map<string, string>();
  if (rows.length === 0) return totals;
  for (const col of columns) {
    if (col.type !== "number") continue;
    let sum = 0;
    let count = 0;
    for (const row of rows) {
      const val = readNumericCell(row[col.key] ?? row[col.title]);
      if (val !== undefined) {
        sum += val;
        count += 1;
      }
    }
    if (count > 0) {
      const rounded = Math.round(sum * 100) / 100;
      const formatted = Number.isInteger(rounded) ? rounded.toLocaleString("en-US") : rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
      totals.set(col.key, formatted);
    }
  }
  return totals;
}

export interface DesignPropDef {
  readonly name: string;
  readonly label: string;
  readonly type: "select" | "boolean" | "number" | "text" | "color";
  readonly options: readonly string[];
  readonly value: string | number | boolean;
}

export interface DesignNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly direction: "horizontal" | "vertical";
  readonly text: string;
  readonly variant: string;
  readonly fill: string;
  readonly color: string;
  readonly radius: number;
  readonly gap: number;
  readonly padding: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly visibleWhen: string | undefined;
  readonly src: string | undefined;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly children: readonly DesignNode[];
}

export interface DesignFrameModel {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly theme: "light" | "dark";
  readonly background: string | undefined;
  readonly props: readonly DesignPropDef[];
  readonly root: DesignNode | undefined;
  readonly nodes: readonly DesignNode[];
}

function parseDesignTokenPx(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?(?:px)?$/u.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed === "{space.1}") return 4;
  if (trimmed === "{space.2}") return 8;
  if (trimmed === "{space.3}") return 12;
  if (trimmed === "{space.4}") return 16;
  if (trimmed === "{space.6}") return 20;
  if (trimmed === "{space.8}") return 24;
  if (trimmed === "{radius.sm}") return 6;
  if (trimmed === "{radius.md}") return 10;
  if (trimmed === "{radius.lg}") return 16;
  if (trimmed === "{radius.full}") return 999;
  return fallback;
}

function parseDesignNode(raw: Record<string, unknown>, idx: number): DesignNode {
  const id = asString(raw.id, `node-${idx}`);
  const kind = asString(raw.kind, asString(raw.type, "card"));
  const dir = raw.direction === "horizontal" ? "horizontal" : "vertical";
  const children = asRecordArray(raw.children).map((c, i) => parseDesignNode(c, i));
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((c): c is string => typeof c === "string") : [];
  const rows = Array.isArray(raw.rows)
    ? raw.rows
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) => r.map((cell) => (typeof cell === "string" || typeof cell === "number" ? String(cell) : "")))
    : [];
  const widthVal = typeof raw.w === "number" ? raw.w : typeof raw.width === "number" ? raw.width : undefined;
  const heightVal = typeof raw.h === "number" ? raw.h : typeof raw.height === "number" ? raw.height : undefined;
  return {
    id,
    kind,
    name: asString(raw.name, asString(raw.label, id)),
    direction: dir,
    text: asString(raw.text, asString(raw.label, "")),
    variant: asString(raw.variant, "default"),
    fill: asString(raw.fill, asString(raw.background, "")),
    color: asString(raw.color, ""),
    radius: parseDesignTokenPx(raw.radius, kind === "card" ? 10 : 6),
    gap: parseDesignTokenPx(raw.gap, 10),
    padding: parseDesignTokenPx(raw.padding, kind === "stack" || kind === "card" ? 14 : 8),
    width: widthVal,
    height: heightVal,
    x: typeof raw.x === "number" && Number.isFinite(raw.x) ? raw.x : undefined,
    y: typeof raw.y === "number" && Number.isFinite(raw.y) ? raw.y : undefined,
    visibleWhen: typeof raw.visibleWhen === "string" && raw.visibleWhen.trim() !== "" ? raw.visibleWhen.trim() : undefined,
    src: typeof raw.src === "string" && raw.src.trim() !== "" ? raw.src.trim() : undefined,
    columns,
    rows,
    children,
  };
}

/** Parses `structure/frames/<name>.json` supporting both `root` trees with `props` and flat `nodes` lists. */
export function parseDesignFrame(path: string, raw: string | undefined): DesignFrameModel {
  const obj = parseJsonObject(raw);
  const vp = isRecord(obj?.viewport) ? obj.viewport : undefined;
  const width = asNumber(vp?.w, asNumber(obj?.width, 1280));
  const height = asNumber(vp?.h, asNumber(obj?.height, 800));
  const theme: "light" | "dark" = obj?.theme === "dark" ? "dark" : "light";
  const background = typeof obj?.background === "string" && obj.background.trim() !== "" ? obj.background.trim() : undefined;

  const props: DesignPropDef[] = asRecordArray(obj?.props).map((p, idx) => {
    const typeRaw = asString(p.type, "text");
    const type: DesignPropDef["type"] = typeRaw === "select" || typeRaw === "boolean" || typeRaw === "number" || typeRaw === "color" ? typeRaw : "text";
    const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === "string") : [];
    const fallbackVal: string | number | boolean = type === "boolean" ? false : type === "number" ? 0 : (options[0] ?? "");
    const value = typeof p.value === "string" || typeof p.value === "number" || typeof p.value === "boolean" ? p.value : fallbackVal;
    const name = asString(p.name, `prop_${idx}`);
    return {
      name,
      label: asString(p.label, name),
      type,
      options,
      value,
    };
  });

  const root = isRecord(obj?.root) ? parseDesignNode(obj.root, 0) : undefined;
  const nodes = asRecordArray(obj?.nodes).map((n, i) => parseDesignNode(n, i));

  return {
    path,
    id: asString(obj?.id, path),
    name: asString(obj?.name, path),
    width,
    height,
    theme,
    background,
    props,
    root,
    nodes,
  };
}

/** Interpolates `{props.<name>}` placeholders inside design frame strings. */
export function resolveDesignExpr(raw: string, propValues: Readonly<Record<string, string | number | boolean>>): string {
  return raw.replace(/\{props\.([a-zA-Z0-9_-]+)\}/gu, (match, key: string) => {
    if (!Object.hasOwn(propValues, key)) return match;
    return String(propValues[key]);
  });
}

const DESIGN_TOKEN_COLORS: Record<"light" | "dark", Readonly<Record<string, string>>> = {
  light: {
    "{color.surface}": themeTokens.cssVars.light.page,
    "{color.panel}": themeTokens.cssVars.light.side,
    "{color.ink}": themeTokens.cssVars.light.ink,
    "{color.muted}": themeTokens.cssVars.light.muted,
    "{color.accent}": themeTokens.cssVars.light.accent,
    "{color.danger}": themeTokens.cssVars.light.berry,
    "{color.border}": themeTokens.cssVars.light["line-strong"],
  },
  dark: {
    "{color.surface}": themeTokens.cssVars.dark.page,
    "{color.panel}": themeTokens.cssVars.dark.side,
    "{color.ink}": themeTokens.cssVars.dark.ink,
    "{color.muted}": themeTokens.cssVars.dark.muted,
    "{color.accent}": themeTokens.cssVars.dark.accent,
    "{color.danger}": themeTokens.cssVars.dark.berry,
    "{color.border}": themeTokens.cssVars.dark["line-strong"],
  },
};

/** Resolves semantic `{color.*}` aliases or CSS hex/rgb strings for the preview artboard theme. */
export function resolveDesignColor(
  raw: string | undefined,
  theme: "light" | "dark",
  propValues?: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const expanded = propValues ? resolveDesignExpr(raw.trim(), propValues) : raw.trim();
  if (expanded === "transparent") return "transparent";
  const mapped = DESIGN_TOKEN_COLORS[theme][expanded];
  if (mapped !== undefined) return mapped;
  if (/^(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/iu.test(expanded)) return expanded;
  return undefined;
}

export interface DesignSystemColorToken {
  readonly name: string;
  readonly group: string;
  readonly light: string;
  readonly dark: string;
  readonly note: string;
}

export interface DesignSystemScaleToken {
  readonly id: string;
  readonly value: string;
}

export interface DesignSystemTypeStyle {
  readonly id: string;
  readonly size: string;
  readonly weight: number;
  readonly lineHeight: number;
}

export interface DesignSystemComponentVariant {
  readonly id: string;
  readonly bg?: string | undefined;
  readonly fg?: string | undefined;
}

export interface DesignSystemComponentSpec {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly variants: readonly DesignSystemComponentVariant[];
  readonly states: readonly string[];
  readonly guidelinesDo: readonly string[];
  readonly guidelinesDont: readonly string[];
}

export interface DesignSystemModel {
  readonly name: string;
  readonly version: string;
  readonly defaultTheme: "light" | "dark";
  readonly colors: readonly DesignSystemColorToken[];
  readonly families: readonly DesignSystemScaleToken[];
  readonly scale: readonly DesignSystemScaleToken[];
  readonly styles: readonly DesignSystemTypeStyle[];
  readonly space: readonly DesignSystemScaleToken[];
  readonly radius: readonly DesignSystemScaleToken[];
  readonly components: readonly DesignSystemComponentSpec[];
}

function parseTokenList(raw: unknown): DesignSystemScaleToken[] {
  if (Array.isArray(raw)) {
    return asRecordArray(raw).map((entry, idx) => ({
      id: asString(entry.id, asString(entry.name, `t${idx + 1}`)),
      value: typeof entry.value === "number" ? `${entry.value}px` : asString(entry.value),
    }));
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([id, val]) => ({
      id,
      value: typeof val === "number" ? `${val}px` : asString(val),
    }));
  }
  return [];
}

/** Parses `structure/tokens.json` and `structure/components/*.json` across both array and object-map formats. */
export function parseDesignSystem(
  rawTokens: string | undefined,
  componentFiles: readonly { readonly path: string; readonly content: string | undefined }[],
  fallbackName: string,
): DesignSystemModel {
  const obj = parseJsonObject(rawTokens);
  const colors: DesignSystemColorToken[] = [];
  if (Array.isArray(obj?.color)) {
    for (const item of asRecordArray(obj.color)) {
      const id = asString(item.id, asString(item.name));
      if (!id) continue;
      const val = item.value;
      const light = isRecord(val) ? asString(val.light) : asString(val);
      const dark = isRecord(val) ? asString(val.dark, light) : light;
      colors.push({
        name: id,
        group: asString(item.group, "color"),
        light,
        dark,
        note: asString(item.note),
      });
    }
  } else if (isRecord(obj?.color)) {
    for (const [name, val] of Object.entries(obj.color)) {
      const light = isRecord(val) ? asString(val.light) : asString(val);
      const dark = isRecord(val) ? asString(val.dark, light) : light;
      colors.push({ name, group: "color", light, dark, note: "" });
    }
  }

  const typeObj = isRecord(obj?.type) ? obj.type : isRecord(obj?.typography) ? obj.typography : undefined;
  const families = isRecord(typeObj) && Array.isArray(typeObj.families) ? parseTokenList(typeObj.families) : isRecord(typeObj) ? parseTokenList(typeObj) : [];
  const scale = isRecord(typeObj) && typeObj.scale !== undefined ? parseTokenList(typeObj.scale) : [];
  const scaleById = new Map(scale.map((s) => [s.id, s.value]));
  const styles: DesignSystemTypeStyle[] = isRecord(typeObj)
    ? asRecordArray(typeObj.styles).map((st, idx) => {
        const rawSize = asString(st.size, "15px");
        const refMatch = /^\{([^}]+)\}$/u.exec(rawSize);
        const size = refMatch && refMatch[1] !== undefined ? (scaleById.get(refMatch[1]) ?? rawSize) : rawSize;
        return {
          id: asString(st.id, `style-${idx + 1}`),
          size,
          weight: asNumber(st.weight, 500),
          lineHeight: asNumber(st.lineHeight, 1.4),
        };
      })
    : [];

  const space = parseTokenList(obj?.space);
  const radius = parseTokenList(obj?.radius);

  const components: DesignSystemComponentSpec[] = componentFiles.map((f) => {
    const c = parseJsonObject(f.content);
    const variantsRaw = Array.isArray(c?.variants) ? c.variants : [];
    const variants: DesignSystemComponentVariant[] = [];
    for (const v of variantsRaw) {
      if (typeof v === "string") {
        variants.push({ id: v });
      } else if (isRecord(v)) {
        const id = asString(v.id, asString(v.name));
        if (id) {
          variants.push({
            id,
            bg: typeof v.bg === "string" ? v.bg : undefined,
            fg: typeof v.fg === "string" ? v.fg : undefined,
          });
        }
      }
    }
    const guidelines = isRecord(c?.guidelines) ? c.guidelines : undefined;
    const guidelinesDo = Array.isArray(guidelines?.do) ? guidelines.do.filter((x): x is string => typeof x === "string") : [];
    const guidelinesDont = Array.isArray(guidelines?.dont) ? guidelines.dont.filter((x): x is string => typeof x === "string") : [];
    return {
      path: f.path,
      id: asString(c?.id, f.path),
      name: asString(c?.title, asString(c?.name, f.path)),
      summary: asString(c?.summary),
      variants,
      states: Array.isArray(c?.states) ? c.states.filter((x): x is string => typeof x === "string") : [],
      guidelinesDo,
      guidelinesDont,
    };
  });

  return {
    name: asString(obj?.name, fallbackName),
    version: asString(obj?.version, "1.0.0"),
    defaultTheme: obj?.defaultTheme === "dark" ? "dark" : "light",
    colors,
    families,
    scale,
    styles,
    space,
    radius,
    components,
  };
}

export interface MotionLayerEval {
  readonly opacity: number;
  readonly offsetY: number;
  readonly scale: number;
}

/** Deterministic pure-time layer animation evaluation from scene-local progress (`0..1`). */
export function evaluateMotionLayer(layer: Record<string, unknown>, localProgress: number): MotionLayerEval {
  const clamped = Math.max(0, Math.min(1, localProgress));
  const baseOpacity = asNumber(layer.opacity, 1);
  const enterEnd = 0.22;
  const enterT = Math.min(1, clamped / enterEnd);
  const eased = 1 - Math.pow(1 - enterT, 3);
  return {
    opacity: Number((baseOpacity * eased).toFixed(3)),
    offsetY: Number(((1 - eased) * 14).toFixed(2)),
    scale: Number((0.95 + eased * 0.05).toFixed(3)),
  };
}

export interface StoryboardShotItem {
  readonly id: string;
  readonly scene: string;
  readonly durationSec: number;
  readonly framing: string;
  readonly camera: string;
  readonly visual: string;
  readonly dialogue: string;
  readonly sfx: string;
  readonly transitionOut: string;
  readonly status: string;
}

export interface StoryboardModel {
  readonly title: string;
  readonly aspectRatio: string;
  readonly fps: number;
  readonly visualTone: string;
  readonly palette: readonly string[];
  readonly shots: readonly StoryboardShotItem[];
}

/** Parses `structure/shots.json` into typed storyboard data. */
export function parseStoryboard(raw: string | undefined, fallbackTitle: string): StoryboardModel {
  const obj = parseJsonObject(raw);
  const styleGuide = isRecord(obj?.styleGuide) ? obj.styleGuide : undefined;
  const palette = Array.isArray(styleGuide?.palette) ? styleGuide.palette.filter((x): x is string => typeof x === "string") : [];
  const shots = asRecordArray(obj?.shots).map((s, idx) => ({
    id: asString(s.id, `sh${String(idx + 1).padStart(2, "0")}`),
    scene: asString(s.scene),
    durationSec: asNumber(s.durationSec, 3),
    framing: asString(s.framing, "wide"),
    camera: asString(s.camera, "static"),
    visual: asString(s.visual),
    dialogue: asString(s.dialogue),
    sfx: asString(s.sfx),
    transitionOut: asString(s.transitionOut, "cut"),
    status: asString(s.status, "draft"),
  }));
  return {
    title: asString(obj?.title, fallbackTitle),
    aspectRatio: asString(obj?.aspectRatio, "16:9"),
    fps: asNumber(obj?.fps, 30),
    visualTone: asString(styleGuide?.visualTone),
    palette,
    shots,
  };
}
