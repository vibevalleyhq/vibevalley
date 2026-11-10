import { execFileSync } from "node:child_process";

/** Hits of each rule, by area (a project or a top folder): on a ratchet they may only go down. */
export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** How one check words its ratchet: the command that writes it down, and where its rules are explained. */
export type RatchetWords = {
  readonly write: string;
  readonly see: string;
  /** What to do once a rule has no hits left; undefined when such a rule just stays at zero. */
  readonly cleared?: (rule: string) => string;
};

/** What is wrong with today's counts against the kept ones (empty when nothing). */
export function ratchetProblems(kept: Counts, now: Counts, words: RatchetWords): string[] {
  const problems: string[] = [];
  for (const rule of [...new Set([...Object.keys(kept), ...Object.keys(now)])].toSorted()) {
    const before = kept[rule] ?? {};
    const after = now[rule] ?? {};
    for (const area of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
      const was = before[area] ?? 0;
      const is = after[area] ?? 0;
      if (is > was)
        problems.push(
          `${area} has ${is} ${rule} (kept ${was}): this change adds what the rule reports, and it may only go down. ` +
            `Fix: write it the way the rule's message says (the hits are listed above). ${words.see}`,
        );
      else if (is < was)
        problems.push(
          `${area} is down to ${is} ${rule} (kept ${was}). Fix: \`${words.write}\` lowers the ratchet, so the room is not spent by the next change. ${words.see}`,
        );
    }
  }
  const cleared = words.cleared;
  if (cleared !== undefined)
    for (const rule of Object.keys(kept).toSorted())
      if (Object.values(now[rule] ?? {}).every((n) => n === 0)) problems.push(`${rule} has no hits left anywhere. ${cleared(rule)}`);
  return problems;
}

/** The rules whose count went up in some area. */
export const grownRules = (kept: Counts, now: Counts): Set<string> =>
  new Set(Object.keys(now).filter((rule) => Object.entries(now[rule] ?? {}).some(([area, n]) => n > (kept[rule]?.[area] ?? 0))));

/** The files this change touches, relative to the repository: at a commit what is staged, otherwise everything that
 * differs from HEAD. */
export function touchedFiles(): Set<string> {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
  const staged = git("diff", "--cached", "--name-only");
  return new Set(staged.length > 0 ? staged : [...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")]);
}
