import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

const TOPOLOGY_DOC = "docs/architecture-topology.md";

export type BoundaryRule = "spine-no-module-import" | "mac-no-server-module-import" | "server-layer-dag" | "server-modules-acyclic";

export interface BoundaryViolation {
  readonly rule: BoundaryRule;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly fix: string;
  readonly details?: readonly string[];
}

export interface RustFile {
  /** POSIX path relative to repository root, e.g. `crates/server/src/lib.rs`. */
  readonly path: string;
  readonly content: string;
}

type Layer = "L1" | "L2" | "L3";
type PeerDomain = "work" | "collab" | "content" | "team/memory";

interface ModuleClassification {
  readonly layer: Layer;
  readonly peerDomain?: PeerDomain;
}

interface Token {
  readonly kind: "ident" | "punct";
  readonly text: string;
  readonly offset: number;
}

interface PathRef {
  readonly segments: readonly string[];
  readonly offset: number;
  readonly inlineMods: readonly string[];
}

interface EdgeOccurrence {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

const KNOWN_DOMAINS = new Set(["work", "team", "collab", "content", "skin", "infra"]);
const INFRA_DOMAIN_ITEMS = new Set(["install_health", "install_health_version"]);
const L3_MODULES = new Set(["team/orchestrator", "team/tool", "team/mcp", "work/cron"]);

export function classifyServerModule(moduleId: string): ModuleClassification | undefined {
  const slash = moduleId.indexOf("/");
  if (slash <= 0 || slash === moduleId.length - 1) return undefined;
  const domain = moduleId.slice(0, slash);
  const name = moduleId.slice(slash + 1);
  if (domain === "infra") return { layer: "L1" };
  if (moduleId === "content/attachment" || moduleId === "team/agent") return { layer: "L1" };
  if (L3_MODULES.has(moduleId) || domain === "skin") return { layer: "L3" };
  if (domain === "work" && name !== "cron") return { layer: "L2", peerDomain: "work" };
  if (domain === "collab") return { layer: "L2", peerDomain: "collab" };
  if (domain === "content" && name !== "attachment") return { layer: "L2", peerDomain: "content" };
  if (moduleId === "team/memory") return { layer: "L2", peerDomain: "team/memory" };
  return undefined;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isSnakeCaseModuleName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/u.test(name);
}

/** Replaces comments and string/char literals with spaces while preserving newlines so line numbers stay exact. */
function stripCommentsAndLiterals(source: string): string {
  const out: string[] = [];
  const len = source.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(source[k] === "\n" ? "\n" : " ");
  };

  while (i < len) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < len && source[i] !== "\n") i++;
      blank(start, i);
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blank(start, i);
      continue;
    }

    const prev = i > 0 ? (source[i - 1] ?? "") : "";
    const prevIsIdent = prev !== "" && isIdentChar(prev);

    if (!prevIsIdent && ((ch === "r" && (next === '"' || next === "#")) || ((ch === "b" || ch === "c") && next === "r"))) {
      const start = i;
      let cursor = ch === "r" ? i + 1 : i + 2;
      let hashes = 0;
      while (cursor < len && source[cursor] === "#") {
        hashes++;
        cursor++;
      }
      if (source[cursor] === '"') {
        cursor++;
        while (cursor < len) {
          if (source[cursor] === '"') {
            let matched = 0;
            while (matched < hashes && source[cursor + 1 + matched] === "#") matched++;
            if (matched === hashes) {
              cursor += 1 + hashes;
              break;
            }
          }
          cursor++;
        }
        blank(start, cursor);
        i = cursor;
        continue;
      }
    }

    if (ch === '"' || (!prevIsIdent && (ch === "b" || ch === "c") && next === '"')) {
      const start = i;
      i = ch === '"' ? i + 1 : i + 2;
      while (i < len) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    if (ch === "'" || (!prevIsIdent && ch === "b" && next === "'")) {
      const start = i;
      const quotePos = ch === "'" ? i : i + 1;
      const afterQuote = source[quotePos + 1] ?? "";
      if (afterQuote === "\\") {
        let cursor = quotePos + 2;
        while (cursor < len && source[cursor] !== "\n") {
          if (source[cursor] === "\\") {
            cursor += 2;
            continue;
          }
          if (source[cursor] === "'") {
            cursor++;
            break;
          }
          cursor++;
        }
        blank(start, cursor);
        i = cursor;
        continue;
      }
      if (afterQuote !== "" && afterQuote !== "'" && afterQuote !== "\n") {
        const cp = source.codePointAt(quotePos + 1);
        const charLen = cp !== undefined && cp > 0xffff ? 2 : 1;
        if (source[quotePos + 1 + charLen] === "'") {
          const end = quotePos + 2 + charLen;
          blank(start, end);
          i = end;
          continue;
        }
      }
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

function splitTopLevelCommas(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail !== "") parts.push(tail);
  return parts;
}

/** True only when a `cfg(...)` predicate guarantees compilation is restricted to `#[cfg(test)]`. */
function isCfgTestPredicate(raw: string): boolean {
  const expr = raw.trim();
  if (expr === "test") return true;
  const open = expr.indexOf("(");
  if (open < 0 || !expr.endsWith(")")) return false;
  const op = expr.slice(0, open).trim();
  const inner = expr.slice(open + 1, -1);
  if (op === "not") return false;
  const parts = splitTopLevelCommas(inner);
  if (parts.length === 0) return false;
  if (op === "all") return parts.some(isCfgTestPredicate);
  if (op === "any") return parts.every(isCfgTestPredicate);
  return false;
}

function findMatchingDelim(code: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

function resolveExternalSubmoduleTargets(filePath: string, modName: string, explicitPath?: string): string[] {
  const dir = dirname(filePath);
  if (explicitPath !== undefined) {
    return [posix.normalize(posix.join(dir, explicitPath))];
  }
  const base = posix.basename(filePath);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") {
    return [posix.normalize(posix.join(dir, `${modName}.rs`)), posix.normalize(posix.join(dir, modName))];
  }
  const stem = base.endsWith(".rs") ? base.slice(0, -3) : base;
  return [
    posix.normalize(posix.join(dir, stem, `${modName}.rs`)),
    posix.normalize(posix.join(dir, stem, modName)),
    posix.normalize(posix.join(dir, `${modName}.rs`)),
  ];
}

function stripCfgTestAndCollectExcluded(source: string, stripped: string, filePath: string): { readonly code: string; readonly excludedSubmodules: string[] } {
  const excludedSubmodules: string[] = [];
  const chars = [...stripped];
  const len = stripped.length;

  const blankRange = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
  };

  let i = 0;
  while (i < len) {
    if (stripped[i] !== "#") {
      i++;
      continue;
    }
    const isInner = stripped[i + 1] === "!";
    const bracketPos = isInner ? i + 2 : i + 1;
    if (stripped[bracketPos] !== "[") {
      i++;
      continue;
    }
    const closeBracket = findMatchingDelim(stripped, bracketPos, "[", "]");
    const attrContent = stripped.slice(bracketPos + 1, closeBracket).trim();
    const cfgMatch = /^cfg\s*\(([\s\S]*)\)$/u.exec(attrContent);
    if (cfgMatch === null || !isCfgTestPredicate(cfgMatch[1] ?? "")) {
      i = closeBracket + 1;
      continue;
    }

    if (isInner) {
      blankRange(0, len);
      return { code: chars.join(""), excludedSubmodules };
    }

    let cursor = closeBracket + 1;
    let explicitPath: string | undefined;

    while (cursor < len) {
      while (cursor < len && /\s/u.test(stripped[cursor] ?? "")) cursor++;
      if (stripped[cursor] === "#" && stripped[cursor + 1] === "[") {
        const nextClose = findMatchingDelim(stripped, cursor + 1, "[", "]");
        const rawAttr = source.slice(cursor + 2, nextClose);
        const pathMatch = /^\s*path\s*=\s*"([^"]+)"\s*$/u.exec(rawAttr);
        if (pathMatch !== null) explicitPath = pathMatch[1];
        cursor = nextClose + 1;
        continue;
      }
      break;
    }

    const tail = stripped.slice(cursor);
    const modDecl = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/u.exec(tail);
    if (modDecl !== null) {
      const modName = modDecl[1] ?? "";
      excludedSubmodules.push(...resolveExternalSubmoduleTargets(filePath, modName, explicitPath));
    }

    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let end = cursor;
    while (end < len) {
      const ch = stripped[end];
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{") braceDepth++;
      else if (ch === "}") {
        if (braceDepth > 0) {
          braceDepth--;
          if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
            end++;
            break;
          }
        }
      } else if (ch === ";" && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        end++;
        break;
      }
      end++;
    }

    blankRange(i, end);
    i = end;
  }

  return { code: chars.join(""), excludedSubmodules };
}

/** Strips comments, string/char literals, and `#[cfg(test)]` items while keeping 1-based line numbers intact. */
export function stripRustNonCode(source: string, filePath = "<memory>.rs"): string {
  const noComments = stripCommentsAndLiterals(source);
  return stripCfgTestAndCollectExcluded(source, noComments, filePath).code;
}

function tokenizeRust(code: string): Token[] {
  const tokens: Token[] = [];
  const len = code.length;
  let i = 0;

  while (i < len) {
    const ch = code[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "r" && code[i + 1] === "#" && isIdentStart(code[i + 2] ?? "")) {
      const start = i;
      i += 2;
      while (i < len && isIdentChar(code[i] ?? "")) i++;
      tokens.push({ kind: "ident", text: code.slice(start + 2, i), offset: start });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentChar(code[i] ?? "")) i++;
      tokens.push({ kind: "ident", text: code.slice(start, i), offset: start });
      continue;
    }
    if (ch === ":" && code[i + 1] === ":") {
      tokens.push({ kind: "punct", text: "::", offset: i });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", text: ch, offset: i });
    i++;
  }

  return tokens;
}

function parseUseTree(tokens: readonly Token[], startIndex: number, prefix: readonly string[], inlineMods: readonly string[], out: PathRef[]): number {
  let i = startIndex;
  const segments = [...prefix];
  let firstOffset: number | undefined;

  if (tokens[i]?.text === "::") i++;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined) break;

    if (tok.text === "{") {
      i++;
      while (i < tokens.length && tokens[i]?.text !== "}") {
        i = parseUseTree(tokens, i, segments, inlineMods, out);
        if (tokens[i]?.text === ",") i++;
      }
      if (tokens[i]?.text === "}") i++;
      return i;
    }

    if (tok.text === "*") {
      out.push({ segments: [...segments, "*"], offset: firstOffset ?? tok.offset, inlineMods });
      return i + 1;
    }

    if (tok.kind === "ident") {
      firstOffset ??= tok.offset;
      if (tok.text !== "self" || segments.length === 0) {
        segments.push(tok.text);
      }
      i++;
      if (tokens[i]?.text === "::") {
        i++;
        continue;
      }
      if (tokens[i]?.kind === "ident" && tokens[i]?.text === "as") {
        i += 2;
      }
      if (segments.length > 0) {
        out.push({ segments, offset: firstOffset, inlineMods });
      }
      return i;
    }

    break;
  }

  return i;
}

function isUseStatementPosition(tokens: readonly Token[], index: number): boolean {
  if (index === 0) return true;
  const prev = tokens[index - 1];
  if (prev === undefined) return true;
  if (prev.text === ";" || prev.text === "{" || prev.text === "}" || prev.text === "]") return true;
  if (prev.kind === "ident" && prev.text === "pub") return true;
  if (prev.text === ")") {
    // Handle `pub(crate) use ...`, `pub(super) use ...`, `pub(in ...) use ...`.
    let depth = 0;
    for (let k = index - 1; k >= 0; k--) {
      if (tokens[k]?.text === ")") depth++;
      else if (tokens[k]?.text === "(") {
        depth--;
        if (depth === 0) {
          return tokens[k - 1]?.kind === "ident" && tokens[k - 1]?.text === "pub";
        }
      }
    }
  }
  return false;
}

function extractPathRefs(code: string): PathRef[] {
  const tokens = tokenizeRust(code);
  const refs: PathRef[] = [];
  const braceStack: (string | undefined)[] = [];
  const activeInlineMods = (): string[] => braceStack.filter((m): m is string => m !== undefined);

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined) break;

    if (tok.kind === "ident" && tok.text === "mod" && tokens[i + 1]?.kind === "ident" && tokens[i + 2]?.text === "{") {
      braceStack.push(tokens[i + 1]?.text);
      i += 3;
      continue;
    }

    if (tok.text === "{") {
      braceStack.push(undefined);
      i++;
      continue;
    }

    if (tok.text === "}") {
      braceStack.pop();
      i++;
      continue;
    }

    if (tok.kind === "ident" && tok.text === "use" && tokens[i + 1]?.text !== "<" && isUseStatementPosition(tokens, i)) {
      const mods = activeInlineMods();
      i = parseUseTree(tokens, i + 1, [], mods, refs);
      while (i < tokens.length && tokens[i]?.text !== ";") i++;
      if (tokens[i]?.text === ";") i++;
      continue;
    }

    const startOffset = tok.offset;
    let cursor = i;
    if (tokens[cursor]?.text === "::") cursor++;
    const head = tokens[cursor];
    if (
      head !== undefined &&
      head.kind === "ident" &&
      (head.text === "crate" || head.text === "vibevalley_server" || head.text === "super" || head.text === "self") &&
      tokens[cursor + 1]?.text === "::"
    ) {
      const segments: string[] = [head.text];
      cursor++;
      while (tokens[cursor]?.text === "::" && tokens[cursor + 1]?.kind === "ident") {
        segments.push(tokens[cursor + 1]?.text ?? "");
        cursor += 2;
      }
      refs.push({ segments, offset: startOffset, inlineMods: activeInlineMods() });
      i = cursor;
      continue;
    }

    i++;
  }

  return refs;
}

function buildLineIndex(source: string): { readonly lines: readonly string[]; readonly lineAt: (offset: number) => number } {
  const lines = source.split("\n");
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(1, hi + 1);
  };
  return { lines, lineAt };
}

function snippetAt(lines: readonly string[], line: number): string {
  return (lines[line - 1] ?? "").trim();
}

function serverFileModulePath(filePath: string): readonly string[] | undefined {
  const prefix = "crates/server/src/modules/";
  if (!filePath.startsWith(prefix) || !filePath.endsWith(".rs")) return undefined;
  const rel = filePath.slice(prefix.length, -3);
  const parts = rel.split("/");
  if (parts.at(-1) === "mod") parts.pop();
  return ["modules", ...parts];
}

function serverModuleIdOfFile(filePath: string): string | undefined {
  const modPath = serverFileModulePath(filePath);
  if (modPath === undefined || modPath.length < 3) return undefined;
  return `${modPath[1]}/${modPath[2]}`;
}

function isSpineFile(filePath: string): boolean {
  return (
    filePath === "crates/server/src/lib.rs" ||
    filePath === "crates/server/src/ports.rs" ||
    (filePath.startsWith("crates/server/src/transport/") && filePath.endsWith(".rs"))
  );
}

function isMacSourceFile(filePath: string): boolean {
  return filePath.startsWith("apps/mac/src/") && filePath.endsWith(".rs");
}

function resolveTargetServerModule(ref: PathRef, fileModPath: readonly string[]): { readonly moduleId?: string; readonly wildcardDomain?: string } | undefined {
  const segs = ref.segments;
  let resolved: string[];

  if (segs[0] === "crate" && segs[1] === "modules") {
    resolved = ["modules", ...segs.slice(2)];
  } else if (segs[0] === "super") {
    const base = [...fileModPath, ...ref.inlineMods];
    let idx = 0;
    while (segs[idx] === "super") {
      if (base.length === 0) return undefined;
      base.pop();
      idx++;
    }
    resolved = [...base, ...segs.slice(idx)];
  } else {
    return undefined;
  }

  if (resolved[0] !== "modules") return undefined;
  const domain = resolved[1];
  const modName = resolved[2];
  if (domain === undefined || !KNOWN_DOMAINS.has(domain)) return undefined;
  if (modName === "*") return { wildcardDomain: domain };
  if (modName === undefined || !isSnakeCaseModuleName(modName)) return undefined;
  if (domain === "infra" && INFRA_DOMAIN_ITEMS.has(modName)) return undefined;
  return { moduleId: `${domain}/${modName}` };
}

function isExcludedByCfgTest(filePath: string, excludedTargets: ReadonlySet<string>): boolean {
  for (const target of excludedTargets) {
    if (filePath === target || filePath.startsWith(`${target}/`)) return true;
  }
  return false;
}

function findStronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlyMap<string, readonly EdgeOccurrence[]>>): string[][] {
  const nodes = [...graph.keys()].toSorted();
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let nextIndex = 0;

  const strongConnect = (v: string) => {
    indexMap.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);

    const neighbors = [...(graph.get(v)?.keys() ?? [])].toSorted();
    for (const w of neighbors) {
      if (!indexMap.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, indexMap.get(w) ?? 0));
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      const scc: string[] = [];
      while (stack.length > 0) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) sccs.push(scc.toSorted());
    }
  };

  for (const node of nodes) {
    if (!indexMap.has(node)) strongConnect(node);
  }
  return sccs;
}

function canonicalizeCycle(cycle: readonly string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if ((cycle[i] ?? "") < (cycle[minIdx] ?? "")) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/** Finds a deterministic set of shortest elementary cycles covering every node in a cyclic SCC. */
function extractCyclesFromScc(scc: readonly string[], graph: ReadonlyMap<string, ReadonlyMap<string, readonly EdgeOccurrence[]>>): string[][] {
  const inScc = new Set(scc);
  const seen = new Set<string>();
  const cycles: string[][] = [];

  for (const start of scc) {
    const prev = new Map<string, string>();
    const queue: string[] = [];
    const visited = new Set<string>();

    const firstHops = [...(graph.get(start)?.keys() ?? [])].filter((n) => inScc.has(n)).toSorted();
    for (const hop of firstHops) {
      prev.set(hop, start);
      visited.add(hop);
      queue.push(hop);
    }

    let found = false;
    while (queue.length > 0 && !found) {
      const curr = queue.shift();
      if (curr === undefined) break;
      const nexts = [...(graph.get(curr)?.keys() ?? [])].filter((n) => inScc.has(n)).toSorted();
      for (const next of nexts) {
        if (next === start) {
          const path: string[] = [curr];
          let p = prev.get(curr);
          while (p !== undefined && p !== start) {
            path.push(p);
            p = prev.get(p);
          }
          path.push(start);
          const canonical = canonicalizeCycle(path.toReversed());
          const key = canonical.join(" -> ");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(canonical);
          }
          found = true;
          break;
        }
        if (!visited.has(next)) {
          visited.add(next);
          prev.set(next, curr);
          queue.push(next);
        }
      }
    }
  }

  return cycles.toSorted((a, b) => a.join(" -> ").localeCompare(b.join(" -> ")));
}

export function auditFiles(files: readonly RustFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const sortedFiles = [...files].toSorted((a, b) => a.path.localeCompare(b.path));

  const preprocessed = new Map<string, { readonly code: string; readonly raw: string }>();
  const excludedTargets = new Set<string>();

  for (const file of sortedFiles) {
    const noComments = stripCommentsAndLiterals(file.content);
    const { code, excludedSubmodules } = stripCfgTestAndCollectExcluded(file.content, noComments, file.path);
    preprocessed.set(file.path, { code, raw: file.content });
    for (const target of excludedSubmodules) excludedTargets.add(target);
  }

  const graph = new Map<string, Map<string, EdgeOccurrence[]>>();
  const ensureNode = (id: string) => {
    let edges = graph.get(id);
    if (edges === undefined) {
      edges = new Map<string, EdgeOccurrence[]>();
      graph.set(id, edges);
    }
    return edges;
  };

  for (const file of sortedFiles) {
    if (isExcludedByCfgTest(file.path, excludedTargets)) continue;
    const entry = preprocessed.get(file.path);
    if (entry === undefined) continue;
    const { code, raw } = entry;
    const { lines, lineAt } = buildLineIndex(raw);
    const refs = extractPathRefs(code);

    if (isSpineFile(file.path)) {
      const seenLine = new Set<number>();
      for (const ref of refs) {
        const isCrateModules = ref.segments[0] === "crate" && ref.segments[1] === "modules";
        const isSelfModulesInLib = file.path === "crates/server/src/lib.rs" && ref.segments[0] === "self" && ref.segments[1] === "modules";
        if (!isCrateModules && !isSelfModulesInLib) continue;
        const line = lineAt(ref.offset);
        if (seenLine.has(line)) continue;
        seenLine.add(line);
        violations.push({
          rule: "spine-no-module-import",
          file: file.path,
          line,
          message: `server spine/transport imports concrete module \`${ref.segments.join("::")}\` (${snippetAt(lines, line)})`,
          fix: `Move the narrow port trait into crates/server/src/ports.rs or crates/server/src/transport/api/ and inject the implementation in start.rs. See ${TOPOLOGY_DOC} Section 3.2.2.`,
        });
      }
      continue;
    }

    if (isMacSourceFile(file.path)) {
      const seenLine = new Set<number>();
      for (const ref of refs) {
        if (ref.segments[0] !== "vibevalley_server" || ref.segments[1] !== "modules") continue;
        const line = lineAt(ref.offset);
        if (seenLine.has(line)) continue;
        seenLine.add(line);
        violations.push({
          rule: "mac-no-server-module-import",
          file: file.path,
          line,
          message: `desktop host imports server internal module \`${ref.segments.join("::")}\` (${snippetAt(lines, line)})`,
          fix: `Consume narrow ports from vibevalley_server::transport::api (e.g. SharedLiveVoice) or protocol types from vibevalley_protocol instead of vibevalley_server::modules::*. See ${TOPOLOGY_DOC} Section 3.2.2.`,
        });
      }
      continue;
    }

    const sourceModule = serverModuleIdOfFile(file.path);
    const fileModPath = serverFileModulePath(file.path);
    if (sourceModule === undefined || fileModPath === undefined) continue;

    ensureNode(sourceModule);
    const sourceClass = classifyServerModule(sourceModule);
    if (sourceClass === undefined) {
      violations.push({
        rule: "server-layer-dag",
        file: file.path,
        line: 1,
        message: `server module \`${sourceModule}\` is not classified in the L1-L3 architecture layers`,
        fix: `Classify \`${sourceModule}\` in scripts/audit/module-boundaries.ts and document its layer in ${TOPOLOGY_DOC} Section 3.2.`,
      });
      continue;
    }

    const seenEdgeOnLine = new Set<string>();
    for (const ref of refs) {
      const resolved = resolveTargetServerModule(ref, fileModPath);
      if (resolved === undefined) continue;
      const line = lineAt(ref.offset);
      const snippet = snippetAt(lines, line);

      if (resolved.wildcardDomain !== undefined) {
        const wildcardKey = `*:${resolved.wildcardDomain}:${line}`;
        if (seenEdgeOnLine.has(wildcardKey)) continue;
        seenEdgeOnLine.add(wildcardKey);
        const sourceDomain = sourceModule.split("/")[0];
        if (resolved.wildcardDomain !== sourceDomain) {
          violations.push({
            rule: "server-layer-dag",
            file: file.path,
            line,
            message: `\`${sourceModule}\` (${sourceClass.layer}) uses wildcard import from domain \`${resolved.wildcardDomain}\` (${snippet})`,
            fix: `Replace wildcard domain imports with explicit L1 or same-domain imports, or route cross-domain calls through Hub::invoke / EventBus / ports.rs. See ${TOPOLOGY_DOC} Section 3.2.1.`,
          });
        }
        continue;
      }

      const targetModule = resolved.moduleId;
      if (targetModule === undefined || targetModule === sourceModule) continue;
      const dedupKey = `${targetModule}:${line}`;
      if (seenEdgeOnLine.has(dedupKey)) continue;
      seenEdgeOnLine.add(dedupKey);

      const edges = ensureNode(sourceModule);
      ensureNode(targetModule);
      let occurrences = edges.get(targetModule);
      if (occurrences === undefined) {
        occurrences = [];
        edges.set(targetModule, occurrences);
      }
      occurrences.push({ file: file.path, line, snippet });

      const targetClass = classifyServerModule(targetModule);
      if (targetClass === undefined) {
        violations.push({
          rule: "server-layer-dag",
          file: file.path,
          line,
          message: `\`${sourceModule}\` imports unclassified server module \`${targetModule}\` (${snippet})`,
          fix: `Classify \`${targetModule}\` in scripts/audit/module-boundaries.ts and ${TOPOLOGY_DOC} Section 3.2.`,
        });
        continue;
      }

      if (sourceClass.layer === "L1" && (targetClass.layer === "L2" || targetClass.layer === "L3")) {
        violations.push({
          rule: "server-layer-dag",
          file: file.path,
          line,
          message: `L1 module \`${sourceModule}\` imports ${targetClass.layer} module \`${targetModule}\` (${snippet})`,
          fix: `L1 modules must have zero upward dependencies; inject a narrow port trait from crates/server/src/ports.rs or subscribe via EventBus. See ${TOPOLOGY_DOC} Section 3.2.`,
        });
      } else if (sourceClass.layer === "L2" && targetClass.layer === "L3") {
        violations.push({
          rule: "server-layer-dag",
          file: file.path,
          line,
          message: `L2 module \`${sourceModule}\` imports L3 module \`${targetModule}\` (${snippet})`,
          fix: `Invert the dependency with a narrow port trait in crates/server/src/ports.rs or move shared pure helpers down to L1 (infra/text). See ${TOPOLOGY_DOC} Section 3.2.`,
        });
      } else if (
        sourceClass.layer === "L2" &&
        targetClass.layer === "L2" &&
        sourceClass.peerDomain !== undefined &&
        targetClass.peerDomain !== undefined &&
        sourceClass.peerDomain !== targetClass.peerDomain
      ) {
        violations.push({
          rule: "server-layer-dag",
          file: file.path,
          line,
          message: `L2 cross-domain import \`${sourceModule}\` (${sourceClass.peerDomain}) -> \`${targetModule}\` (${targetClass.peerDomain}) (${snippet})`,
          fix: `L2 peer domains (work, collab, content, team/memory) must not import each other directly; use Hub::invoke<O>, EventBus, SpaceState, or a read-only port in crates/server/src/ports.rs. See ${TOPOLOGY_DOC} Section 3.2.1.`,
        });
      }
    }
  }

  const sccs = findStronglyConnectedComponents(graph);
  for (const scc of sccs) {
    const cycles = extractCyclesFromScc(scc, graph);
    for (const cycle of cycles) {
      const hops: string[] = [];
      let primaryFile = "crates/server/src/modules/mod.rs";
      let primaryLine = 1;
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i] ?? "";
        const to = cycle[(i + 1) % cycle.length] ?? "";
        const occ = graph.get(from)?.get(to)?.[0];
        if (i === 0 && occ !== undefined) {
          primaryFile = occ.file;
          primaryLine = occ.line;
        }
        const where = occ !== undefined ? `${occ.file}:${occ.line}: ${occ.snippet}` : "<unknown>";
        hops.push(`${from} -> ${to} (${where})`);
      }
      const cycleLabel = `${cycle.join(" -> ")} -> ${cycle[0] ?? ""}`;
      violations.push({
        rule: "server-modules-acyclic",
        file: primaryFile,
        line: primaryLine,
        message: `directed cycle in server modules: ${cycleLabel}`,
        fix: `Break the module cycle by extracting shared data/ports downward or routing writes via Hub::invoke / EventBus so crates/server/src/modules/ forms a strict DAG. See ${TOPOLOGY_DOC} Section 3.2.2.`,
        details: hops,
      });
    }
  }

  return violations;
}

function collectWorkspaceRustFiles(root: string): RustFile[] {
  const candidates = new Set<string>();
  for (const single of ["crates/server/src/lib.rs", "crates/server/src/ports.rs"]) {
    if (existsSync(resolve(root, single))) candidates.add(single);
  }
  const patterns = ["crates/server/src/transport/**/*.rs", "crates/server/src/modules/**/*.rs", "apps/mac/src/**/*.rs"];
  for (const pattern of patterns) {
    for (const rel of globSync(pattern, { cwd: root })) {
      candidates.add(rel.replaceAll("\\", "/"));
    }
  }
  return [...candidates].toSorted().map((path) => ({
    path,
    content: readFileSync(resolve(root, path), "utf8"),
  }));
}

export function auditWorkspace(root: string): { readonly filesScanned: number; readonly violations: readonly BoundaryViolation[] } {
  const files = collectWorkspaceRustFiles(root);
  return { filesScanned: files.length, violations: auditFiles(files) };
}

export function formatViolations(violations: readonly BoundaryViolation[]): string {
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(`[${v.rule}] ${v.file}:${v.line}: ${v.message}`);
    if (v.details !== undefined) {
      for (const detail of v.details) lines.push(`  edge: ${detail}`);
    }
    lines.push(`  Fix: ${v.fix}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const { filesScanned, violations } = auditWorkspace(root);
  if (violations.length > 0) {
    const byRule = new Map<BoundaryRule, number>();
    for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    const summary = [...byRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(", ");
    console.error(`module boundaries: ${violations.length} violation(s) (${summary})\n\n${formatViolations(violations)}`);
    process.exit(1);
  }
  console.log(`module boundaries: ${filesScanned} files ok (spine, mac, L0-L3 DAG, acyclic)`);
}
