// What a source file says about its edges, read from its syntax tree (oxc, as Vite parses it) rather than by pattern: an
// import over several lines, a re-export, a dynamic import or a read through a local name is seen as the compiler sees
// it. The structure tests (modules, layers, the contract, the pyramid) all ask these.

import { parseSync } from "vite";

/** One import or re-export: where from, whether it is for types only, and the names it takes ("*" for a namespace or
 * an export *, "default"). */
export interface Edge {
  readonly from: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}

// oxc's tree is ESTree with TypeScript's nodes; walked as plain objects, so only the fields read here are typed.
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
/** The nodes of a list field; none when the field is not a list. */
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? v.filter(isNode) : []);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Every node under n, each with its parent. */
function* walk(n: Node, parent?: Node): Generator<{ node: Node; parent: Node | undefined }> {
  yield { node: n, parent };
  for (const [key, v] of Object.entries(n)) {
    if (key === "parent") continue;
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) yield* walk(c, n);
    } else if (isNode(v)) yield* walk(v, n);
  }
}

/** The file's program; path's extension says whether it is TSX. */
export function programOf(path: string, source: string): Node {
  const program: unknown = parseSync(path, source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program;
  if (!isNode(program)) throw new Error(`${path} parsed to no program`);
  return program;
}

const nameOf = (n: unknown): string | undefined => {
  if (!isNode(n)) return undefined;
  if (n.type === "Identifier") return text(n.name);
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  return undefined;
};

const literal = (n: unknown): string | undefined => (isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : undefined);

/** Every import, export … from and dynamic import() of a string. */
export function edgesOf(path: string, source: string): Edge[] {
  const out: Edge[] = [];
  for (const { node } of walk(programOf(path, source))) {
    if (node.type === "ImportDeclaration") {
      const specifiers = nodes(node.specifiers);
      const names = specifiers.map((s) =>
        s.type === "ImportNamespaceSpecifier" ? "*" : s.type === "ImportDefaultSpecifier" ? "default" : (nameOf(s.imported) ?? ""),
      );
      // Under verbatimModuleSyntax only `import type` is dropped: `import { type A }` still loads the module.
      out.push({ from: literal(node.source) ?? "", typeOnly: node.importKind === "type", names });
    } else if (node.type === "ExportNamedDeclaration" && isNode(node.source)) {
      const specifiers = nodes(node.specifiers);
      out.push({ from: literal(node.source) ?? "", typeOnly: node.exportKind === "type", names: specifiers.map((s) => nameOf(s.local) ?? "") });
    } else if (node.type === "ExportAllDeclaration") {
      out.push({ from: literal(node.source) ?? "", typeOnly: node.exportKind === "type", names: ["*"] });
    } else if (node.type === "ImportExpression") {
      const from = literal(node.source);
      if (from !== undefined) out.push({ from, typeOnly: false, names: ["*"] });
    }
  }
  return out;
}

/** What a file imports for its values: imports and re-exports that are not type-only, side-effect and dynamic ones. */
export const importsOf = (path: string, source: string): string[] => edgesOf(path, source).flatMap((e) => (e.typeOnly ? [] : [e.from]));

/** The names a file exports itself (declarations and `export { … }` without a source), types included. */
export function exportsOf(path: string, source: string): string[] {
  const out: string[] = [];
  for (const { node } of walk(programOf(path, source))) {
    if (node.type !== "ExportNamedDeclaration" || isNode(node.source)) continue;
    const d = node.declaration;
    if (isNode(d)) {
      const names = d.type === "VariableDeclaration" ? nodes(d.declarations).map((v) => nameOf(v.id)) : [nameOf(d.id)];
      for (const name of names) if (name !== undefined) out.push(name);
    }
    for (const s of nodes(node.specifiers)) out.push(nameOf(s.exported) ?? "");
  }
  return out;
}

/** The values a file declares and exports itself (no types), each with where its export statement starts. */
export function exportedValuesOf(path: string, source: string): { readonly name: string; readonly start: number }[] {
  const out: { name: string; start: number }[] = [];
  for (const statement of nodes(programOf(path, source).body)) {
    if (statement.type !== "ExportNamedDeclaration" || isNode(statement.source)) continue;
    const d = statement.declaration;
    if (!isNode(d) || d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration") continue;
    const names = d.type === "VariableDeclaration" ? nodes(d.declarations).map((v) => nameOf(v.id)) : [nameOf(d.id)];
    const start = typeof statement.start === "number" ? statement.start : 0;
    for (const name of names) if (name !== undefined) out.push({ name, start });
  }
  return out;
}

const isCallOf = (n: Node, object: string, method: string) =>
  n.type === "CallExpression" &&
  isNode(n.callee) &&
  n.callee.type === "MemberExpression" &&
  n.callee.computed !== true &&
  nameOf(n.callee.object) === object &&
  nameOf(n.callee.property) === method;

/** The fields read off what object.method() returns: right off the call (`core.state().issues`, `?.` too), through a
 * const it is kept in (`const s = core.state(); s.issues`), or destructured (`const { issues } = core.state()`). A
 * name kept is followed through the whole file, which is enough for the short functions that read it. */
export function readsOf(path: string, source: string, object: string, method: string): string[] {
  const program = programOf(path, source);
  const parents = new Map<Node, Node | undefined>();
  const out = new Set<string>();
  const kept = new Set<string>();
  for (const { node, parent } of walk(program)) parents.set(node, parent);
  const fieldOf = (member: Node) => (member.computed === true ? undefined : nameOf(member.property));
  for (const [node, parent] of parents) {
    if (!isCallOf(node, object, method) || !parent) continue;
    // `x?.y` wraps the member in a ChainExpression; the call may be the object of the member inside it.
    if (parent.type === "MemberExpression" && parent.object === node) {
      const f = fieldOf(parent);
      if (f) out.add(f);
    } else if (parent.type === "VariableDeclarator" && parent.init === node && isNode(parent.id)) {
      const name = nameOf(parent.id);
      if (parent.id.type === "Identifier" && name !== undefined) kept.add(name);
      else if (parent.id.type === "ObjectPattern")
        for (const p of nodes(parent.id.properties)) {
          const key = p.type === "Property" && p.computed !== true ? nameOf(p.key) : undefined;
          if (key !== undefined) out.add(key);
        }
    }
  }
  if (kept.size > 0)
    for (const node of parents.keys())
      if (node.type === "MemberExpression" && isNode(node.object) && node.object.type === "Identifier" && kept.has(nameOf(node.object) ?? "")) {
        const f = fieldOf(node);
        if (f) out.add(f);
      }
  return [...out];
}

/** Whether the file calls object.method(…) anywhere. */
export const calls = (path: string, source: string, object: string, method: string): boolean => {
  for (const { node } of walk(programOf(path, source))) if (isCallOf(node, object, method)) return true;
  return false;
};
