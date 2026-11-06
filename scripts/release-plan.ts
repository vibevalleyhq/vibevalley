import { newer } from "@vibevalley/desktop/releases";

export type Stage = "alpha" | "beta" | "final";

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: { readonly stage: "alpha" | "beta"; readonly n: number } | undefined;
}

const tagPattern = /^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/u;

function versionOf(tag: string): Version | undefined {
  const m = tagPattern.exec(tag);
  if (!m) return undefined;
  const stage = m[4] === "alpha" || m[4] === "beta" ? m[4] : undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: stage ? { stage, n: Number(m[5]) } : undefined };
}

const text = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre.stage}.${v.pre.n}` : ""}`;

export interface Plan {
  readonly version: string;
  readonly tag: string;
  /** The branch it is tagged on; for a first beta, the one cut from main. */
  readonly branch: string;
  /** The first beta cuts release/x.y from main. */
  readonly cut: boolean;
  /** The tag the database's baseline must be the same as: within a beta line the farm never starts over. */
  readonly schemaSince: string | undefined;
}

export type Planned = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly why: string };

const refuse = (why: string): Planned => ({ ok: false, why });
const planned = (v: Version, branch: string, cut: boolean, schemaSince: string | undefined): Planned => ({
  ok: true,
  plan: { version: text(v), tag: `v${text(v)}`, branch, cut, schemaSince },
});

const lineBranch = /^release\/(\d+)\.(\d+)$/u;

export function planRelease(stage: Stage, tags: readonly string[], branch: string): Planned {
  const all = tags.flatMap((t) => versionOf(t) ?? []);
  const sameRelease = (v: Version, w: Version) => v.major === w.major && v.minor === w.minor && v.patch === w.patch;
  const highest = (vs: readonly Version[]) => vs.reduce<Version | undefined>((a, v) => (a === undefined || newer(text(v), text(a)) ? v : a), undefined);
  const maxN = (vs: readonly Version[], s: "alpha" | "beta") => Math.max(0, ...vs.flatMap((v) => (v.pre?.stage === s ? [v.pre.n] : [])));

  // What main is working towards: the highest x.y.0 that has no beta or release yet, else the next minor.
  const mainTarget = (): Version => {
    const top = highest(all) ?? { major: 0, minor: 0, patch: 0, pre: undefined };
    const settled = all.some((v) => v.major === top.major && v.minor === top.minor && v.patch === 0 && v.pre?.stage !== "alpha");
    return settled || all.length === 0
      ? { major: top.major, minor: top.minor + 1, patch: 0, pre: undefined }
      : { major: top.major, minor: top.minor, patch: 0, pre: undefined };
  };

  if (stage === "alpha") {
    if (branch !== "main") return refuse(`alphas are tagged on main, not ${branch}. Fix: git switch main`);
    const target = mainTarget();
    const n = maxN(
      all.filter((v) => sameRelease(v, target)),
      "alpha",
    );
    return planned({ ...target, pre: { stage: "alpha", n: n + 1 } }, "main", false, undefined);
  }

  if (stage === "beta" && branch === "main") {
    const target = mainTarget();
    return planned({ ...target, pre: { stage: "beta", n: 1 } }, `release/${target.major}.${target.minor}`, true, undefined);
  }

  const line = lineBranch.exec(branch);
  if (!line)
    return refuse(
      `${stage === "beta" ? "a later beta" : "a release"} is tagged on its release/x.y branch, not ${branch}. Fix: git switch release/<x.y> (the first beta cuts it from main)`,
    );
  const [major, minor] = [Number(line[1]), Number(line[2])];
  const inLine = all.filter((v) => v.major === major && v.minor === minor);
  const firstBeta = `v${major}.${minor}.0-beta.1`;
  if (!inLine.some((v) => v.pre?.stage === "beta")) return refuse(`${branch} has no beta yet. Fix: on main, vp run release beta cuts it`);
  const top = highest(inLine);
  if (top === undefined) return refuse(`${branch} has no tags`);
  const released = (patch: number) => inLine.some((v) => v.patch === patch && v.pre === undefined);

  if (stage === "beta") {
    // After a release, the next beta is the next patch's.
    const patch = released(top.patch) ? top.patch + 1 : top.patch;
    const target: Version = { major, minor, patch, pre: undefined };
    const n = maxN(
      inLine.filter((v) => sameRelease(v, target)),
      "beta",
    );
    return planned({ ...target, pre: { stage: "beta", n: n + 1 } }, branch, false, firstBeta);
  }

  if (released(top.patch))
    return refuse(`${major}.${minor}.${top.patch} is released already. Fix: vp run release beta for ${major}.${minor}.${top.patch + 1}, then release final`);
  if (top.pre?.stage !== "beta") return refuse(`a release follows a beta of the same version. Fix: vp run release beta first`);
  return planned({ major, minor, patch: top.patch, pre: undefined }, branch, false, firstBeta);
}
