/** The number text says (git's counts and timestamps, an API's decimal string), or fallback when it says none. */
export const numberIn = (text: string | undefined, fallback = 0) => {
  const n = Number(text?.trim() || Number.NaN);
  return Number.isFinite(n) ? n : fallback;
};
