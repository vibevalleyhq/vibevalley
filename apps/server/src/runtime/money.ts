// Money in words.

export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? "不到 ¥0.01" : "¥" + cny.toFixed(2));

export const quotaLow = 15;
