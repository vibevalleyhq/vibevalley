/** What Solid's `class` takes: a string, a list of them, or `{ "class": on }`; false and undefined add nothing. */
export type ClassValue = string | false | undefined | Readonly<Record<string, boolean | undefined>> | readonly ClassValue[];

/**
 * One class string from a part's own classes and its caller's `class`. It only joins: two utilities for the same property
 * (`px-2` and `px-4`) are settled by Tailwind's stylesheet order, not by which comes last here, so a part's `class` prop
 * adds what the part does not set (placement, width, margin) and a change to what it does set is a variant (vv-tailwind).
 */
export function cx(...values: readonly ClassValue[]): string {
  const out: string[] = [];
  const add = (value: ClassValue) => {
    if (value === undefined || value === false || value === "") return;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value as readonly ClassValue[]) add(item);
    else for (const [name, on] of Object.entries(value)) if (on === true) out.push(name);
  };
  for (const value of values) add(value);
  return out.join(" ");
}
