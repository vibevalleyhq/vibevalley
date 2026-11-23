import { globSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

import { stripRustNonCode } from "./module-boundaries.ts";

const CONCURRENCY_DOC = "docs/style/rust-async-concurrency.md";

// Shrink-only ceiling for non-test `rt::block_on(` calls under `crates/server/src/`.
// This ceiling may only decrease as sync wrappers migrate to async; never raise it.
export const SERVER_BLOCK_ON_CEILING = 152;

const NON_HTTP_RAW_TCP_ALLOWLIST: Readonly<
  Record<
    string,
    {
      readonly maxSites: number;
      readonly requiredTokens: readonly string[];
      readonly reason: string;
    }
  >
> = {
  "crates/server/tests/connector.rs": {
    maxSites: 1,
    requiredTokens: ["serve_ws", "tungstenite::accept"],
    reason: "serve_ws() binds std::net::TcpListener for non-HTTP WebSocket gateway mocks; serve_http() uses axum::Router + tokio::net::TcpListener.",
  },
};

export type RustRatchetRule =
  | "no-pollster"
  | "no-thread-sleep-in-zeroed-zones"
  | "no-mac-rt-handle"
  | "no-rich-sync-try-current"
  | "no-raw-tcp-http-mock"
  | "no-block-on-in-async-server";

export interface SourceFile {
  /** POSIX path relative to repository root, e.g. `crates/server/src/lib.rs`. */
  readonly path: string;
  readonly text: string;
}

export interface RatchetViolation {
  readonly rule: RustRatchetRule;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly fix: string;
  readonly see: string;
  readonly details?: readonly string[];
}

export interface AuditRatchetsOptions {
  readonly serverBlockOnCeiling?: number;
}

export interface AuditRatchetsResult {
  readonly filesScanned: number;
  readonly serverBlockOnCount: number;
  readonly serverBlockOnCeiling: number;
  readonly violations: readonly RatchetViolation[];
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

/** Strips Rust comments and string/char literals while preserving newlines so 1-based line numbers stay exact. */
function stripRustCommentsAndLiterals(source: string): string {
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

/** Strips TOML `#` comments outside string literals while keeping string values and line numbers intact. */
function stripTomlComments(source: string): string {
  const out: string[] = [];
  const len = source.length;
  let i = 0;

  while (i < len) {
    const ch = source[i] ?? "";

    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
      out.push('"""');
      i += 3;
      while (i < len) {
        if (source[i] === "\\") {
          out.push(source.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
          out.push('"""');
          i += 3;
          break;
        }
        out.push(source[i] ?? "");
        i++;
      }
      continue;
    }

    if (ch === '"') {
      out.push('"');
      i++;
      while (i < len) {
        if (source[i] === "\\") {
          out.push(source.slice(i, i + 2));
          i += 2;
          continue;
        }
        out.push(source[i] ?? "");
        if (source[i] === '"') {
          i++;
          break;
        }
        if (source[i] === "\n") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "'" && source[i + 1] === "'" && source[i + 2] === "'") {
      out.push("'''");
      i += 3;
      while (i < len) {
        if (source[i] === "'" && source[i + 1] === "'" && source[i + 2] === "'") {
          out.push("'''");
          i += 3;
          break;
        }
        out.push(source[i] ?? "");
        i++;
      }
      continue;
    }

    if (ch === "'") {
      out.push("'");
      i++;
      while (i < len) {
        out.push(source[i] ?? "");
        if (source[i] === "'" || source[i] === "\n") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "#") {
      while (i < len && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
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

function findMatchingBracket(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === "[") depth++;
    else if (code[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

/** Collects target paths of external `#[cfg(test)] mod ...;` declarations so test-only files stay excluded. */
function collectCfgTestSubmodules(filePath: string, raw: string, stripped: string): string[] {
  const targets: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] !== "#" || stripped[i + 1] !== "[") {
      i++;
      continue;
    }
    const closeBracket = findMatchingBracket(stripped, i + 1);
    const attrContent = stripped.slice(i + 2, closeBracket).trim();
    const cfgMatch = /^cfg\s*\(([\s\S]*)\)$/u.exec(attrContent);
    if (cfgMatch === null || !isCfgTestPredicate(cfgMatch[1] ?? "")) {
      i = closeBracket + 1;
      continue;
    }
    let cursor = closeBracket + 1;
    let explicitPath: string | undefined;
    while (cursor < stripped.length) {
      while (cursor < stripped.length && /\s/u.test(stripped[cursor] ?? "")) cursor++;
      if (stripped[cursor] === "#" && stripped[cursor + 1] === "[") {
        const nextClose = findMatchingBracket(stripped, cursor + 1);
        const rawAttr = raw.slice(cursor + 2, nextClose);
        const pathMatch = /^\s*path\s*=\s*"([^"]+)"\s*$/u.exec(rawAttr);
        if (pathMatch !== null) explicitPath = pathMatch[1];
        cursor = nextClose + 1;
        continue;
      }
      break;
    }
    const modDecl = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/u.exec(stripped.slice(cursor));
    if (modDecl !== null) {
      targets.push(...resolveExternalSubmoduleTargets(filePath, modDecl[1] ?? "", explicitPath));
    }
    i = cursor;
  }
  return targets;
}

function isExcludedByCfgTest(filePath: string, excludedTargets: ReadonlySet<string>): boolean {
  for (const target of excludedTargets) {
    if (filePath === target || filePath.startsWith(`${target}/`)) return true;
  }
  return false;
}

function isCrateOrMacCargoToml(path: string): boolean {
  return (path.startsWith("crates/") || path.startsWith("apps/mac/")) && path.endsWith("/Cargo.toml");
}

function isCrateOrMacRust(path: string): boolean {
  return (path.startsWith("crates/") || path.startsWith("apps/mac/")) && path.endsWith(".rs");
}

function isThreadSleepZeroedZone(path: string): boolean {
  return (path.startsWith("crates/server/tests/") || path.startsWith("apps/mac/src/")) && path.endsWith(".rs");
}

function hasDocumentedThreadSleepAllowance(rawLines: readonly string[], line: number): boolean {
  const inspect = (text: string): "valid" | "missing-reason" | "none" => {
    const match = /\/\/\s*ratchet-allow:\s*no-thread-sleep\b(.*)$/u.exec(text);
    if (match === null) return "none";
    const reason = (match[1] ?? "").replace(/^[\s:\-—]+/u, "").trim();
    return reason.length >= 3 && /[A-Za-z0-9\u4e00-\u9fff]/u.test(reason) ? "valid" : "missing-reason";
  };

  const currentStatus = inspect(rawLines[line - 1] ?? "");
  if (currentStatus === "valid") return true;
  if (currentStatus === "missing-reason") return false;

  for (let idx = line - 2; idx >= 0; idx--) {
    const trimmed = (rawLines[idx] ?? "").trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("//")) break;
    const prevStatus = inspect(trimmed);
    if (prevStatus === "valid") return true;
    if (prevStatus === "missing-reason") return false;
  }
  return false;
}

function checkPollster(file: SourceFile, strippedCode: string): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  const { lines, lineAt } = buildLineIndex(file.text);
  const seenLine = new Set<number>();
  const re = /\bpollster\b/gu;

  for (const match of strippedCode.matchAll(re)) {
    const line = lineAt(match.index);
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    violations.push({
      rule: "no-pollster",
      file: file.path,
      line,
      message: `\`pollster\` is forbidden in crates/ and apps/mac/ (${snippetAt(lines, line)})`,
      fix: "Remove `pollster` from Cargo.toml and Rust code; use `vibevalley_runtime::rt::block_on` at sync boundaries or convert callers to async (`Hub::on_async`).",
      see: CONCURRENCY_DOC,
    });
  }
  return violations;
}

function checkThreadSleep(file: SourceFile, strippedRust: string): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  const { lines, lineAt } = buildLineIndex(file.text);
  const seenLine = new Set<number>();
  const re = /\b(?:std::)?thread::sleep\b/gu;

  for (const match of strippedRust.matchAll(re)) {
    const line = lineAt(match.index);
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    if (hasDocumentedThreadSleepAllowance(lines, line)) continue;
    violations.push({
      rule: "no-thread-sleep-in-zeroed-zones",
      file: file.path,
      line,
      message: `\`std::thread::sleep\` is forbidden in zeroed zones (${snippetAt(lines, line)})`,
      fix: "Use virtual-clock `tokio::time::advance` / `tokio::time::sleep` (`#[tokio::test(start_paused = true)]`) or event-driven sync (`Notify`, channels); if an OS thread genuinely requires a sleep, add `// ratchet-allow: no-thread-sleep -- <reason>`.",
      see: CONCURRENCY_DOC,
    });
  }
  return violations;
}

function checkMacRtHandle(file: SourceFile, strippedRust: string): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  const { lines, lineAt } = buildLineIndex(file.text);
  const seenLine = new Set<number>();
  const re = /\b(?:vibevalley_runtime::)?rt::handle\b/gu;

  for (const match of strippedRust.matchAll(re)) {
    const line = lineAt(match.index);
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    violations.push({
      rule: "no-mac-rt-handle",
      file: file.path,
      line,
      message: `\`rt::handle\` is forbidden in \`apps/mac/src/\` (${snippetAt(lines, line)})`,
      fix: "Use async `Server::call_with_async`, `Hub::call_with`, or GPUI `cx.spawn` instead of reaching for `vibevalley_runtime::rt::handle`.",
      see: CONCURRENCY_DOC,
    });
  }
  return violations;
}

function checkRichSyncTryCurrent(file: SourceFile, strippedRust: string): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  const { lines, lineAt } = buildLineIndex(file.text);
  const seenLine = new Set<number>();
  const re = /\bHandle::try_current\b/gu;

  for (const match of strippedRust.matchAll(re)) {
    const line = lineAt(match.index);
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    violations.push({
      rule: "no-rich-sync-try-current",
      file: file.path,
      line,
      message: `\`Handle::try_current()\` is forbidden outside \`crates/rich/src/highlight.rs\` (${snippetAt(lines, line)})`,
      fix: "Move background CPU rendering behind `crate::highlight::run_offloaded` instead of probing `Handle::try_current()` and falling back synchronously on the UI thread.",
      see: CONCURRENCY_DOC,
    });
  }
  return violations;
}

function checkRawTcpHttpMock(file: SourceFile, strippedRust: string): RatchetViolation[] {
  const importsTokioTcpListener = /\buse\s+tokio::net::(?:\{[^}]*\bTcpListener\b[^}]*\}|\bTcpListener\b)/u.test(strippedRust);
  const importsStdTcpListener = /\buse\s+std::net::(?:\{[^}]*\bTcpListener\b[^}]*\}|\bTcpListener\b)/u.test(strippedRust);

  const { lines, lineAt } = buildLineIndex(file.text);
  const rawSites: number[] = [];
  const seenLine = new Set<number>();
  const re = /((?:[A-Za-z_][A-Za-z0-9_]*::)*)TcpListener::bind\s*\(/gu;

  for (const match of strippedRust.matchAll(re)) {
    const prefix = match[1] ?? "";
    if (prefix === "tokio::net::") continue;
    if (prefix === "" && importsTokioTcpListener && !importsStdTcpListener) continue;
    const line = lineAt(match.index);
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    rawSites.push(line);
  }

  const allow = NON_HTTP_RAW_TCP_ALLOWLIST[file.path];
  if (allow !== undefined && rawSites.length <= allow.maxSites && allow.requiredTokens.every((token) => strippedRust.includes(token))) {
    return [];
  }

  return rawSites.map((line) => ({
    rule: "no-raw-tcp-http-mock",
    file: file.path,
    line,
    message: `raw \`TcpListener::bind\` test mock in \`crates/server/tests/\` (${snippetAt(lines, line)})`,
    fix: "Replace raw `std::net::TcpListener::bind` HTTP mocks with `axum::Router` + `tokio::net::TcpListener::bind` + `axum::serve`.",
    see: CONCURRENCY_DOC,
  }));
}

interface BlockOnSite {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function collectServerBlockOnSites(files: readonly SourceFile[]): BlockOnSite[] {
  const serverSrcFiles = files.filter((f) => f.path.startsWith("crates/server/src/") && f.path.endsWith(".rs"));
  const excludedTargets = new Set<string>();

  for (const file of serverSrcFiles) {
    const stripped = stripRustCommentsAndLiterals(file.text);
    for (const target of collectCfgTestSubmodules(file.path, file.text, stripped)) {
      excludedTargets.add(target);
    }
  }

  const sites: BlockOnSite[] = [];
  const re = /\b(?:vibevalley_runtime::)?rt::block_on\s*\(/gu;

  for (const file of serverSrcFiles) {
    if (isExcludedByCfgTest(file.path, excludedTargets)) continue;
    const nonTestCode = stripRustNonCode(file.text, file.path);
    const { lines, lineAt } = buildLineIndex(file.text);
    for (const match of nonTestCode.matchAll(re)) {
      const line = lineAt(match.index);
      sites.push({
        file: file.path,
        line,
        snippet: snippetAt(lines, line),
      });
    }
  }

  return sites;
}

function normalizeFiles(files: readonly SourceFile[]): SourceFile[] {
  return files.map((f) => ({ path: f.path.replaceAll("\\", "/"), text: f.text })).toSorted((a, b) => a.path.localeCompare(b.path));
}

function runRatchets(
  files: readonly SourceFile[],
  options?: AuditRatchetsOptions,
): { readonly serverBlockOnCount: number; readonly serverBlockOnCeiling: number; readonly violations: RatchetViolation[] } {
  const sorted = normalizeFiles(files);
  const violations: RatchetViolation[] = [];
  const ceiling = options?.serverBlockOnCeiling ?? SERVER_BLOCK_ON_CEILING;

  for (const file of sorted) {
    if (isCrateOrMacCargoToml(file.path)) {
      violations.push(...checkPollster(file, stripTomlComments(file.text)));
      continue;
    }

    if (!isCrateOrMacRust(file.path)) continue;
    const strippedRust = stripRustCommentsAndLiterals(file.text);

    violations.push(...checkPollster(file, strippedRust));

    if (isThreadSleepZeroedZone(file.path)) {
      violations.push(...checkThreadSleep(file, strippedRust));
    }

    if (file.path.startsWith("apps/mac/src/")) {
      violations.push(...checkMacRtHandle(file, strippedRust));
    }

    if (file.path.startsWith("crates/rich/src/") && file.path !== "crates/rich/src/highlight.rs") {
      violations.push(...checkRichSyncTryCurrent(file, strippedRust));
    }

    if (file.path.startsWith("crates/server/tests/")) {
      violations.push(...checkRawTcpHttpMock(file, strippedRust));
    }
  }

  const blockOnSites = collectServerBlockOnSites(sorted);
  if (blockOnSites.length > ceiling) {
    const first = blockOnSites[0];
    violations.push({
      rule: "no-block-on-in-async-server",
      file: first?.file ?? "crates/server/src/lib.rs",
      line: first?.line ?? 1,
      message: `\`crates/server/src/\` has ${blockOnSites.length} non-test \`rt::block_on(\` call(s), exceeding shrink-only ceiling ${ceiling}`,
      fix: "Convert the new caller to `async fn` / `Hub::on_async` instead of adding `rt::block_on(`, or migrate existing sites to async and lower `SERVER_BLOCK_ON_CEILING` in `scripts/audit/rust-ratchets.ts`.",
      see: CONCURRENCY_DOC,
      details: blockOnSites.map((s) => `${s.file}:${s.line}: ${s.snippet}`),
    });
  }

  return {
    serverBlockOnCount: blockOnSites.length,
    serverBlockOnCeiling: ceiling,
    violations,
  };
}

export function auditRustRatchets(files: readonly SourceFile[], options?: AuditRatchetsOptions): RatchetViolation[] {
  return runRatchets(files, options).violations;
}

function collectWorkspaceFiles(root: string): SourceFile[] {
  const candidates = new Set<string>();
  const patterns = ["crates/**/Cargo.toml", "apps/mac/**/Cargo.toml", "crates/**/*.rs", "apps/mac/**/*.rs"];
  for (const pattern of patterns) {
    for (const rel of globSync(pattern, { cwd: root, exclude: ["**/target/**", "**/node_modules/**"] })) {
      candidates.add(rel.replaceAll("\\", "/"));
    }
  }
  return [...candidates].toSorted().map((path) => ({
    path,
    text: readFileSync(resolve(root, path), "utf8"),
  }));
}

export function auditWorkspaceRatchets(root: string, options?: AuditRatchetsOptions): AuditRatchetsResult {
  const files = collectWorkspaceFiles(root);
  const { serverBlockOnCount, serverBlockOnCeiling, violations } = runRatchets(files, options);
  return {
    filesScanned: files.length,
    serverBlockOnCount,
    serverBlockOnCeiling,
    violations,
  };
}

export function formatRatchetViolations(violations: readonly RatchetViolation[]): string {
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(`[${v.rule}] ${v.file}:${v.line}: ${v.message}`);
    if (v.details !== undefined) {
      for (const detail of v.details) lines.push(`  site: ${detail}`);
    }
    lines.push(`  Fix: ${v.fix}`);
    lines.push(`  See: ${v.see}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const { filesScanned, serverBlockOnCount, serverBlockOnCeiling, violations } = auditWorkspaceRatchets(root);
  if (violations.length > 0) {
    const byRule = new Map<RustRatchetRule, number>();
    for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    const summary = [...byRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(", ");
    console.error(
      `rust ratchets: ${violations.length} violation(s) (${summary}; server block_on=${serverBlockOnCount}/${serverBlockOnCeiling})\n\n${formatRatchetViolations(violations)}`,
    );
    process.exit(1);
  }
  console.log(`rust ratchets: ${filesScanned} files ok (server block_on=${serverBlockOnCount}/${serverBlockOnCeiling})`);
}
