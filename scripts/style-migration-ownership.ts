import { parseSync } from "vite-plus";

export interface InlineStyleReview {
  path: string;
  expression: string;
  reason: string;
}

const metadata: Readonly<Record<string, true>> = {
  start: true,
  end: true,
  raw: true,
  loc: true,
  range: true,
  comments: true,
  leadingComments: true,
  trailingComments: true,
};

export function styleFingerprint(node: unknown): string {
  return JSON.stringify(node, (key: string, value: unknown) => (metadata[key] === true ? undefined : value));
}

export function reviewedStyleKeys(reviews: readonly InlineStyleReview[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const review of reviews) {
    if (review.reason.trim() === "") throw new Error(`Missing inline-style owner: ${review.path}`);
    const parsed = parseSync("review.tsx", `<div ${review.expression} />`, { lang: "tsx" });
    if (parsed.errors.length !== 0) throw new Error(`Invalid inline-style review: ${review.path}: ${review.expression}`);
    const statement = parsed.program.body[0];
    if (statement?.type !== "ExpressionStatement" || statement.expression.type !== "JSXElement") throw new Error("Invalid review element");
    const attributes = statement.expression.openingElement.attributes;
    const attribute = attributes[0];
    if (attributes.length !== 1 || attribute?.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "style")
      throw new Error(`Review must identify exactly one style attribute: ${review.path}`);
    result.set(styleFingerprint(attribute), review.reason);
  }
  return result;
}

const semanticClasses: Readonly<Record<string, readonly string[]>> = {
  "design/issue-farming/index.html":
    "act acts arrow aside ask blk box branch btn card card-copy check chore crew detail-cards done fold g2 g3 g4 gate go grid hand here hoe lead mock mock-body mock-head need new no note ok pixel plot pulled px q rail soil sp stage stages t-berry t-leaf t-plain t-water t-wheat tag weeds who who2".split(
      " ",
    ),
  "apps/web/src/ui/Markdown.tsx": ["markdown"],
  "apps/web/src/ui/layout.tsx": ["window-drag"],
  "apps/web/src/ui/richText.ts": [
    "mention",
    "task",
    "code-block",
    "code-head",
    "code-lang",
    "code-act",
    "code-more",
    "diagram",
    "diagram-stage",
    "diagram-error",
  ],
  "design/mockups/index.html": ["missing", "small", "tag"],
  "apps/site/test/prerender/fixture/App.tsx": ["below"],
  "apps/web/public/opening.html": ["scene", "column", "brand", "runway", "sprite-position", "sprite", "bar", "fill", "words", "problem"],
  "packages/base-ui/test/popover.test.tsx": ["mine"],
};

export function ownedSemanticClasses(path: string): ReadonlySet<string> {
  return new Set(semanticClasses[path] ?? []);
}
