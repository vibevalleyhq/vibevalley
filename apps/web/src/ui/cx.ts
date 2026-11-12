import type { JSX } from "@solidjs/web";

/**
 * One class string from a part's own classes and its caller's `class`, taking what Solid's `class` takes (a string, a
 * list, `{ "name": on }`). It only joins: two utilities for the same property (`px-2` and `px-4`) are settled by
 * Tailwind's stylesheet order, not by which comes last here, so a part's `class` prop adds what the part does not set
 * (placement, width, margin) and a change to what it does set is a variant (vv-tailwind).
 */
export function cx(...values: readonly JSX.ClassValue[]): string {
  const out: string[] = [];
  const add = (value: JSX.ClassValue) => {
    if (typeof value === "string") {
      if (value !== "") out.push(value);
    } else if (typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) for (const item of value) add(item);
    else if (typeof value === "object" && value !== null) for (const [name, on] of Object.entries(value)) if (on === true) out.push(name);
  };
  for (const value of values) add(value);
  return out.join(" ");
}
