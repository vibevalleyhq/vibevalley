import { PkmTierValues } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";

export const tierFolder: Readonly<Record<T.PkmTier, string>> = {
  inbox: "00_Inbox",
  repo: "01_Repos",
  area: "02_Areas",
  resource: "03_Resources",
  archive: "04_Archives",
  journal: "journals",
};

/** How much a hit in each tier counts in a search: what is being worked on first, what is archived last. */
export const tierWeight: Readonly<Record<T.PkmTier, number>> = {
  repo: 2,
  area: 1.5,
  journal: 1.4,
  resource: 1.2,
  inbox: 1,
  archive: 0.5,
};

/** The server's own files in the vault (clipped snapshots); never read as pages. */
export const ownFolder = ".pkm";

const folderTier = new Map(PkmTierValues.map((tier) => [tierFolder[tier], tier]));

export const fileNameOf = (title: string) => {
  const name = title
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\//gu, "__")
    .replace(/[<>:"|?*]/gu, "")
    .replace(/\s+/gu, "-");
  return name.endsWith(".md") ? name : `${name}.md`;
};

export const titleOfFile = (file: string) => (file.split("/").at(-1) ?? file).replace(/\.md$/u, "").replace(/__/gu, "/");

export const fileOf = (tier: T.PkmTier, title: string) => `${tierFolder[tier]}/${fileNameOf(title)}`;

export const tierOfFile = (file: string): T.PkmTier => folderTier.get(file.split("/")[0] ?? "") ?? "inbox";

/** A journal page's title for a day: 2026_11_03, as Logseq names them. */
export const journalTitle = (at: number) => {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}_${two(d.getMonth() + 1)}_${two(d.getDate())}`;
};

/** The day of at as deadline:: values are written: 2026-11-03. */
export const dayOf = (at: number) => journalTitle(at).replace(/_/gu, "-");

/** A journal's day from its file (journals/2026_11_03.md → 2026-11-03); none for a file not named for a day. */
export function journalDay(file: string): string | undefined {
  const m = /^journals\/(\d{4})_(\d{2})_(\d{2})\.md$/u.exec(file);
  return m ? `${m[1] ?? ""}-${m[2] ?? ""}-${m[3] ?? ""}` : undefined;
}

/** 2026-11-03 → 2026_11_03, as journalTitle names today's: change them together. */
export const journalTitleOf = (day: string) => day.replace(/-/gu, "_");
