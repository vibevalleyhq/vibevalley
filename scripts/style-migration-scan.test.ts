import { expect, test } from "vite-plus/test";

import { scanStyleCss, scanStyleHtml, scanStyleSource } from "./style-migration-scan";

const source = (text: string, path = "apps/web/src/Fixture.tsx") => scanStyleSource(path, text);
const categories = (text: string) => source(text).findings.map((finding) => finding.category);

test("inventory follows constants, arrays, conditions and legacy helpers", () => {
  const result = source('const base = "flex p-2"; const View = () => <div class={cx(base, active && "gap-2", ["grid", ready ? "hidden" : "block"])} />;');
  expect(result.parsed).toBe(true);
  expect(result.findings.filter((finding) => finding.category === "unconverted-class-token").map((finding) => finding.evidence)).toEqual([
    "flex",
    "p-2",
    "gap-2",
    "grid",
    "hidden",
    "block",
  ]);
  expect(result.findings.some((finding) => finding.category === "legacy-class-helper")).toBe(true);
});

test.each([
  ["<div class={makeClasses()} />", "unknown-class-call"],
  ["<div class={`bg-${tone}`} />", "unknown-class-template"],
  ["<div class={missing} />", "unresolved-class-binding"],
  ["const a = b; const b = a; <div class={a} />", "unresolved-class-binding"],
  ['function A(){ const cls="a"; return <div class={cls}/> } function B(){const cls="b"; return <div class={cls}/>}', "unresolved-class-binding"],
  ["<div classList={{[name]: true}} />", "unknown-class-map"],
  ["<div class={styles.root} />", "unresolved-class-member"],
])("inventory rejects unknown class producers: %s", (text, category) => {
  expect(categories(text)).toContain(category);
});

test("inventory recognizes the imported StyleX attrs boundary, not an arbitrary lookalike", () => {
  const result = source('import * as sx from "@stylexjs/stylex"; const View=()=> <div {...sx.attrs(styles.root)} class={sx.attrs(styles.other).class} />;');
  expect(result.findings).toEqual([]);
  expect(result.classifications.every((classification) => classification.kind === "stylex-attrs")).toBe(true);
  expect(categories("<div class={sx.attrs(styles.root).class} />")).toContain("unresolved-class-member");
});

test("inventory checks imperative DOM class producers", () => {
  const result = source(
    'element.className="flex"; element.setAttribute("class", "grid"); element.classList.add("p-2", "gap-1"); element.classList.toggle("hidden", condition);',
  );
  expect(result.expressions).toBe(4);
  expect(result.findings.map((finding) => finding.evidence)).toEqual(["flex", "grid", "p-2", "gap-1", "hidden"]);
});

test("inventory requires typed boundaries for caller-supplied styling", () => {
  expect(categories("type Props = { class?: string; className?: string };")).toEqual(["unconverted-styled-contract", "unconverted-styled-contract"]);
  const result = source('type Props = { class?: JSX.HTMLAttributes<HTMLDivElement>["class"] };');
  expect(result.findings).toEqual([]);
  expect(result.classifications[0]?.kind).toBe("typed-class-boundary");
});

test("semantic classes are a closed list, not arbitrary identifiers", () => {
  const result = scanStyleSource("apps/web/src/Fixture.tsx", '<div class="rich-text flex" />', new Set(["rich-text"]));
  expect(result.findings.map((finding) => finding.evidence)).toEqual(["flex"]);
  expect(result.classifications[0]?.kind).toBe("permitted-semantic-class");
});

test("React rejection is website-specific", () => {
  const text = 'import React from "react"; import {motion} from "motion/react";';
  expect(source(text, "apps/site/src/Fixture.tsx").findings.map((finding) => finding.category)).toEqual(["website-react-import", "website-react-import"]);
  expect(source(text, "apps/mobile/Fixture.tsx").findings).toEqual([]);
});

test("inventory checks imports and configuration without interpreting negative fixture strings as imports", () => {
  expect(categories('import tailwind from "@tailwindcss/vite"; const format={sortTailwindcss:{}};')).toEqual(["tailwind-import", "tailwind-configuration"]);
  expect(source("const fixture = 'import tailwind from \"tailwindcss\"';").findings).toEqual([]);
});

test("parse failures cannot become empty successful scans", () => {
  const result = source("const broken = <div class={");
  expect(result.parsed).toBe(false);
  expect(result.findings.map((finding) => finding.category)).toContain("parse-error");
});

test("stylesheet inventory counts directives and composition variables, not comments", () => {
  const findings = scanStyleCss(
    "src/style.css",
    '/* @apply fake; */ @import "tailwindcss"; @theme { --color-ink: black; } @utility panel { @apply flex; } .item { box-shadow: var(--tw-shadow); }',
  );
  expect(findings.map((finding) => finding.evidence)).toEqual(['@import "tailwindcss"', "@theme", "@utility", "@apply", "--tw-shadow"]);
});

test("stylesheet inventory does not interpret content strings as directives", () => {
  expect(scanStyleCss("src/style.css", '.label::after { content: "@apply --tw-shadow"; }')).toEqual([]);
});

test("HTML inventory includes attributes, styles, scripts and event handlers", () => {
  const result = scanStyleHtml(
    "apps/site/public/page.html",
    '<!doctype html><html><head><style>.x{box-shadow:var(--tw-shadow)}</style></head><body><div class="flex" onclick="this.className=\'hidden\'"></div><script>element.classList.add("grid")</script></body></html>',
  );
  expect(result.parsed).toBe(true);
  expect(result.findings.map((finding) => finding.evidence)).toEqual(["--tw-shadow", "flex", "hidden", "grid"]);
});

test("HTML JSON scripts are classified without interpreting their strings as code", () => {
  const result = scanStyleHtml(
    "apps/site/public/page.html",
    '<!doctype html><html><head><script type="application/ld+json">{"text":"import React from \\\"react\\\""}</script></head><body></body></html>',
  );
  expect(result.findings).toEqual([]);
  expect(result.classifications[0]?.kind).toBe("static-json-script");
});

test("unreviewed inline styles cannot disappear from inventory", () => {
  expect(categories("<div style={{ width: 20 }} />")).toContain("unreviewed-inline-style");
  const result = source('import * as sx from "@stylexjs/stylex"; <div style={sx.attrs(styles.width(20)).style} />');
  expect(result.findings).toEqual([]);
});

test("malformed stylesheets fail inventory", () => {
  expect(scanStyleCss("src/style.css", "not a stylesheet").map((finding) => finding.category)).toContain("css-parse-error");
});
