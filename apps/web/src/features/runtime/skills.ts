// The skills the runtimes on this machine report.

import type { RuntimeInfo } from "@vibevalley/protocol";

export interface InstalledSkill {
  readonly name: string;
  readonly description?: string;
  /** Where each runtime has it: a path, or a settings scope. */
  readonly runtimes: readonly { readonly runtime: string; readonly source?: string }[];
}

/** By name: one skill several runtimes carry is one entry, with the first description given. */
export function installedSkills(runtimes: readonly RuntimeInfo[]): InstalledSkill[] {
  const byName = new Map<string, { description?: string; runtimes: { runtime: string; source?: string }[] }>();
  for (const r of runtimes)
    for (const s of r.skills ?? []) {
      let got = byName.get(s.name);
      if (!got) byName.set(s.name, (got = { runtimes: [] }));
      if (!got.description && s.description) got.description = s.description;
      got.runtimes.push({ runtime: r.id, ...(s.source ? { source: s.source } : {}) });
    }
  return [...byName].map(([name, v]) => ({ name, ...v })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
