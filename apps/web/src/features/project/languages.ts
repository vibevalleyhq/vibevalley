import { t } from "@vibevalley/i18n";
import { type LanguageCount } from "@vibevalley/protocol";

import { compareText, or } from "@/base/order";

interface LangDef {
  readonly label: string;
  readonly color: string;
  readonly names: readonly string[];
}

const langs: Record<string, LangDef> = {
  typescript: { label: "TypeScript", color: "#3178c6", names: ["typescript", "tsx", "ts"] },
  javascript: { label: "JavaScript", color: "#f1e05a", names: ["javascript", "jsx", "js", "mjs", "cjs"] },
  python: { label: "Python", color: "#3572a5", names: ["python", "py", "cython"] },
  go: { label: "Go", color: "#00add8", names: ["go", "golang"] },
  rust: { label: "Rust", color: "#dea584", names: ["rust", "rs"] },
  java: { label: "Java", color: "#b07219", names: ["java"] },
  kotlin: { label: "Kotlin", color: "#a97bff", names: ["kotlin", "kt"] },
  swift: { label: "Swift", color: "#f05138", names: ["swift"] },
  c: { label: "C", color: "#555555", names: ["c", "c header"] },
  cpp: { label: "C++", color: "#f34b7d", names: ["c++", "cpp", "c++ header"] },
  csharp: { label: "C#", color: "#178600", names: ["c#", "csharp", "cs"] },
  ruby: { label: "Ruby", color: "#701516", names: ["ruby", "rb"] },
  php: { label: "PHP", color: "#4f5d95", names: ["php", "hack"] },
  shell: { label: "Shell", color: "#89e051", names: ["shell", "bash", "zsh", "sh", "fish"] },
  html: { label: "HTML", color: "#e34c26", names: ["html"] },
  css: { label: "CSS", color: "#563d7c", names: ["css", "less"] },
  sql: { label: "SQL", color: "#e38c00", names: ["sql", "plpgsql", "tsql", "plsql"] },
  dart: { label: "Dart", color: "#00b4ab", names: ["dart"] },
  lua: { label: "Lua", color: "#000080", names: ["lua", "luau"] },
  scala: { label: "Scala", color: "#c22d40", names: ["scala"] },
  elixir: { label: "Elixir", color: "#6e4a7e", names: ["elixir", "ex"] },
  haskell: { label: "Haskell", color: "#5e5086", names: ["haskell", "hs"] },
  zig: { label: "Zig", color: "#ec915c", names: ["zig"] },
  r: { label: "R", color: "#198ce7", names: ["r", "rmarkdown"] },
  markdown: { label: "Markdown", color: "#083fa1", names: ["markdown", "md", "mdx"] },
  json: { label: "JSON", color: "#292929", names: ["json", "json with comments", "json5", "jsonc"] },
  yaml: { label: "YAML", color: "#cb171e", names: ["yaml", "yml"] },
  julia: { label: "Julia", color: "#a270ba", names: ["julia", "jl"] },
  vue: { label: "Vue", color: "#41b883", names: ["vue"] },
  svelte: { label: "Svelte", color: "#ff3e00", names: ["svelte"] },
  docker: { label: "Dockerfile", color: "#384d54", names: ["dockerfile", "docker"] },
  jupyter: { label: "Jupyter", color: "#da5b0b", names: ["jupyter notebooks", "jupyter notebook", "jupyter", "ipynb"] },
  sass: { label: "Sass", color: "#c6538c", names: ["scss", "sass"] },
  powershell: { label: "PowerShell", color: "#012456", names: ["powershell", "ps1"] },
  terraform: { label: "Terraform", color: "#844fba", names: ["hcl", "terraform", "tf"] },
  other: { label: t("web.project.project.otherLang"), color: "#a08c70", names: [] },
};

const byName = new Map(Object.entries(langs).flatMap(([id, def]) => def.names.map((n) => [n, id] as const)));

export interface Language {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

function languageOf(name: string): Language {
  const id = byName.get(name.trim().toLowerCase()) ?? "other";
  const def = langs[id]!;
  return { id, label: id === "other" && name.trim() ? name.trim() : def.label, color: def.color };
}

export const langIcon = (id: string) => `lang-${id}`;

export interface LanguageShare extends Language {
  /** Prose in Markdown counts as comments. */
  readonly lines: number;
  readonly files: number;
  /** 0..1. */
  readonly share: number;
}

/** By label, aliases merged, most lines first; past `top`, the rest is one 其他 (one leftover keeps its name). */
export function languageShares(counts: readonly LanguageCount[], top: number | undefined = 7): LanguageShare[] {
  const merged = new Map<string, { language: Language; lines: number; files: number }>();
  for (const c of counts) {
    const language = languageOf(c.name);
    const e = merged.get(language.label);
    merged.set(language.label, { language, lines: (e?.lines ?? 0) + c.code + c.comments, files: (e?.files ?? 0) + c.files });
  }
  const all = [...merged.values()].filter((e) => e.lines > 0).toSorted((a, b) => or(b.lines - a.lines, compareText(a.language.label, b.language.label)));
  const total = all.reduce((n, e) => n + e.lines, 0);
  const cut = top;
  const rest = all.length > cut ? all.slice(cut) : [];
  const kept = rest.length > 1 ? all.slice(0, cut) : all;
  const shares = kept.map((e) => ({ ...e.language, lines: e.lines, files: e.files, share: total > 0 ? e.lines / total : 0 }));
  if (rest.length <= 1) return shares;
  const lines = rest.reduce((n, e) => n + e.lines, 0);
  const other = langs.other!;
  return [
    ...shares,
    { id: "other", label: other.label, color: other.color, lines, files: rest.reduce((n, e) => n + e.files, 0), share: total > 0 ? lines / total : 0 },
  ];
}
