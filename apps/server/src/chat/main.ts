import { parseArgs } from "node:util";

import { homeOf, savedLocale } from "@vibevalley/home";
import { setLocale } from "@vibevalley/i18n";

import { messageOf } from "#/base/errors.ts";

// The conversation speaks the farm's language: set before the chat loads, as it says its words as it loads.
setLocale(savedLocale(homeOf()));

const { ownChat, runtimeChat } = await import("./chat.ts");

const text = { type: "string" } as const;

/** The given flags that were given, and no others. */
const given = <K extends string>(values: Partial<Record<K, string | boolean | undefined>>, keys: readonly K[]) => {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = values[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
};

async function run(argv: readonly string[]): Promise<void> {
  if (argv[0] === "runtime") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { model: text, effort: text, resume: text, cwd: text, prompt: { ...text, short: "p" } },
    });
    const id = positionals[0];
    if (id === undefined) throw new Error("vibevalley chat runtime <runtime>: name the runtime");
    const { prompt, ...rest } = given(values, ["model", "effort", "resume", "cwd", "prompt"]);
    return runtimeChat(id, { ...rest, ...(prompt !== undefined ? { p: prompt } : {}) });
  }
  const { values } = parseArgs({
    args: [...argv],
    options: { cwd: text, name: text, model: text, mcp: text, prompt: { ...text, short: "p" }, version: { type: "boolean" } },
  });
  if (values.version === true) {
    process.stdout.write("0.1.0\n");
    return;
  }
  const p = values.prompt;
  return ownChat({ cwd: values.cwd ?? "", name: values.name ?? "vibevalley", model: values.model ?? "", mcp: values.mcp ?? "", ...(p ? { p } : {}) });
}

// A conversation takes Ctrl+C itself (stop the turn, again to quit), so the signal must not end the program: until a
// conversation listens for it, it is ignored.
process.on("SIGINT", () => {});

try {
  await run(process.argv.slice(2));
  process.exit(0);
} catch (e) {
  // What went wrong is said on stderr.
  process.stderr.write(`${messageOf(e)}\n`);
  process.exit(1);
}
