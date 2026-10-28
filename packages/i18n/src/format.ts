// A message's placeholders are {name}; a value is a string or a number, put in as it is.

export type Params = Readonly<Record<string, string | number>>;

const placeholder = /\{([A-Za-z_$][\w$]*)\}/g;

export function format(text: string, params: Params): string {
  return text.replace(placeholder, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The placeholders a message names, each once, in order. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(placeholder)].map((m) => m[1]!))];
}
