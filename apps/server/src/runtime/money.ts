// Money in words.
import { runtimeWording } from "./words.ts";

export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? runtimeWording().lessThanCent : "¥" + cny.toFixed(2));

export const quotaLow = 15;
