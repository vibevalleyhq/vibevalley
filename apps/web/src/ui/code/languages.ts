// The languages code is coloured in, by a file's extension, each loaded the first time a file of it is shown: an import
// per language, so the page's bundle carries none of them (Vite splits each into its own chunk).

import type { LanguageInput } from "shiki/core";

type Load = () => Promise<{ default: LanguageInput }>;

const loaders: Record<string, Load> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
};

const byExtension: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
};

/** The language of a file by its name, or of a fenced block by its tag; none for one not coloured. */
export function languageOf(nameOrTag: string): string | undefined {
  const tag = nameOrTag.toLowerCase();
  if (loaders[tag]) return tag;
  const ext = tag.includes(".") ? tag.slice(tag.lastIndexOf(".") + 1) : tag;
  return byExtension[ext];
}

export const loadLanguage = (lang: string) => loaders[lang]!().then((m) => m.default);
