import { type ProjectSummary } from "@vibevalley/protocol";

import { compareText, or } from "@/base/order";

/** Only repository home URLs, never credentials, arbitrary git transports or command-line options. */
export function githubRepository(input: string): { name: string; url: string } | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/u.exec(input.trim());
  if (!m) return undefined;
  const name = m[2]!.replace(/\.git$/u, "");
  if (!name || name === "." || name === "..") return undefined;
  return { name, url: `https://github.com/${m[1]}/${name}.git` };
}

/** Newest commit first, then by name. */
export const sortProjects = (list: readonly ProjectSummary[]) => [...list].toSorted((a, b) => or((b.last ?? 0) - (a.last ?? 0), compareText(a.name, b.name)));

/** As toLocaleString('zh-CN') writes it: 「12,345」. */
export const number = (n: number) => (n < 0 ? "-" : "") + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

export const percent = (share: number) => (share >= 0.1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`);
