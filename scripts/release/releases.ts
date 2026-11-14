/** The order of versions: x.y.z, and before it its alphas, then its betas. */
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/u;

/** A version's place in the order: its numbers, then its stage (alpha before beta before the release), then n. */
function rankOf(v: string): number[] | undefined {
  const m = versionPattern.exec(v);
  if (!m) return undefined;
  const stage = m[4] === "alpha" ? 0 : m[4] === "beta" ? 1 : 2;
  return [Number(m[1]), Number(m[2]), Number(m[3]), stage, Number(m[5] ?? 0)];
}

/** a is a later version than b: 0.4.0-alpha.2 < 0.4.0-beta.1 < 0.4.0 < 0.4.1; one that is neither is never later. */
export function newer(a: string, b: string): boolean {
  const x = rankOf(a);
  const y = rankOf(b);
  if (!x || !y) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
