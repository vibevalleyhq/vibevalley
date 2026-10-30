export const numberIn = (text: string | undefined, fallback = 0) => {
  const n = Number(text?.trim() || Number.NaN);
  return Number.isFinite(n) ? n : fallback;
};
