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
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? v.filter(isNode) : []);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function* walk(n: Node): Generator<Node> {
  yield n;
  for (const [key, v] of Object.entries(n)) {
    if (key === "parent") continue;
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) yield* walk(c);
    } else if (isNode(v)) yield* walk(v);
  }
}

/** The file's program; path's extension says whether it is TSX. */
export function programOf(path: string, source: string): Node {
  const program: unknown = parseSync(path, source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program;
  if (!isNode(program)) throw new Error(`${path} parsed to no program`);
  return program;
}

const literal = (n: unknown): string | undefined => (isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : undefined);
const nameOf = (n: unknown): string | undefined => (isNode(n) && n.type === "Identifier" ? text(n.name) : literal(n));

/** Every import, export … from and dynamic import() of a string. */
export function edgesOf(path: string, source: string): Edge[] {
  const out: Edge[] = [];
  for (const node of walk(programOf(path, source))) {
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

/** The names a file exports itself (declarations and `export { … }` without a source), types included. */
export function exportsOf(path: string, source: string): string[] {
  const out: string[] = [];
  for (const node of walk(programOf(path, source))) {
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
