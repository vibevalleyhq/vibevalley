import { Argument, Command, type CommanderError, InvalidArgumentError, Option } from "commander";
import type { z } from "zod";

import { t } from "@vibevalley/i18n";

import { type Ctx, type GlobalFlag, globalsOf } from "#/base/format.ts";
import { exit, Failure, type Io } from "#/base/output.ts";

type About = Parameters<typeof t>[0];

/** One argument or flag of a command: how it is declared to the parser, and how its parsed value is read back typed. */
export interface Param<A> {
  readonly positional: boolean;
  readonly attach: (cmd: Command) => void;
  /** at: for an argument, its place among the command's arguments. */
  readonly read: (cmd: Command, at: number) => A;
}

type Params = Readonly<Record<string, Param<unknown>>>;
type Input<P extends Params> = { readonly [K in keyof P]: P[K] extends Param<infer A> ? A : never };

/** The type a parameter's value is written with in help. */
const typeOf = new WeakMap<Argument | Option, string>();

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isOneOf =
  <const V extends string>(values: readonly V[]) =>
  (v: unknown): v is V =>
    typeof v === "string" && values.some((x) => x === v);
/** A value the parser already held to its choices. */
const oneOf =
  <const V extends string>(values: readonly V[]) =>
  (v: unknown): V => {
    if (isOneOf(values)(v)) return v;
    throw new Error(`the parser let through ${String(v)}, not one of ${values.join("|")}`);
  };

function argument<A>(spec: string, about: string | undefined, type: string, read: (raw: unknown) => A, more?: (a: Argument) => void): Param<A> {
  return {
    positional: true,
    attach: (cmd) => {
      const a = new Argument(spec, about);
      more?.(a);
      typeOf.set(a, type);
      cmd.addArgument(a);
    },
    read: (cmd, at) => {
      const raw: unknown = cmd.processedArgs[at];
      return read(raw);
    },
  };
}

function flag<A>(flags: string, about: string | undefined, type: string, read: (raw: unknown) => A, more?: (o: Option) => void): Param<A> {
  const o = new Option(flags, about);
  const key = o.attributeName();
  return {
    positional: false,
    attach: (cmd) => {
      const made = new Option(flags, about);
      more?.(made);
      typeOf.set(made, type);
      cmd.addOption(made);
    },
    read: (cmd) => {
      const raw: unknown = cmd.getOptionValue(key);
      return read(raw);
    },
  };
}

const asInt = (v: string): number => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n)) throw new InvalidArgumentError(`Expected an integer, got "${v}"`);
  return n;
};

/** The arguments a command takes, in the order they are written. */
export const arg = {
  /** A required word. */
  text: (name: string, about: About) => argument(`<${name}>`, t(about), "string", (v) => text(v) ?? ""),
  /** A word that may be left out, then def. */
  textOr: (name: string, def: string, about: About) =>
    argument(
      `[${name}]`,
      t(about),
      "string",
      (v) => text(v) ?? def,
      (a) => void a.default(def),
    ),
  optional: (name: string, about: About) => argument(`[${name}]`, t(about), "string", text),
  /** A required word, decoded by schema (a branded id): one it does not take is an invalid value. */
  decoded: <A>(name: string, schema: z.ZodType<A>, about: About) =>
    argument(
      `<${name}>`,
      t(about),
      "string",
      (v) => schema.parse(v),
      (a) =>
        void a.argParser((v) => {
          const got = schema.safeParse(v);
          if (!got.success) throw new InvalidArgumentError(got.error.issues[0]?.message ?? "invalid");
          return v;
        }),
    ),
  choice: <const V extends string>(name: string, values: readonly V[], about: About) =>
    argument(`<${name}>`, t(about), values.join("|"), oneOf(values), (a) => void a.choices(values)),
  optionalChoice: <const V extends string>(name: string, values: readonly V[], about: About) =>
    argument(
      `[${name}]`,
      t(about),
      values.join("|"),
      (v) => (isOneOf(values)(v) ? v : undefined),
      (a) => void a.choices(values),
    ),
  /** One word or more (`words`). */
  words: (about: About) => argument("<words...>", t(about), "string", texts),
  /** Any number of words, none too. */
  optionalWords: (about: About) => argument("[words...]", t(about), "string", texts),
};

/** The flags a command takes. */
export const opt = {
  /** A value that may be left out. */
  text: (name: string, about: About) => flag(`--${name} <${name}>`, t(about), "string", text),
  textOr: (name: string, def: string, about: About) => flag(`--${name} <${name}>`, t(about), "string", (v) => text(v) ?? def),
  /** A value that must be given (no description of its own: the command's says what they are). */
  required: (name: string) =>
    flag(
      `--${name} <${name}>`,
      undefined,
      "string",
      (v) => text(v) ?? "",
      (o) => void o.makeOptionMandatory(),
    ),
  bool: (name: string, about: About) => flag(`--${name}`, t(about), "boolean", (v) => v === true),
  int: (name: string, about: About) =>
    flag(
      `--${name} <${name}>`,
      t(about),
      "integer",
      (v) => (typeof v === "number" ? v : undefined),
      (o) => void o.argParser(asInt),
    ),
  intOr: (name: string, def: number, about: About) =>
    flag(
      `--${name} <${name}>`,
      t(about),
      "integer",
      (v) => (typeof v === "number" ? v : def),
      (o) => void o.argParser(asInt),
    ),
  choice: <const V extends string>(name: string, values: readonly V[], about: About) =>
    flag(
      `--${name} <${name}>`,
      t(about),
      values.join("|"),
      (v) => (isOneOf(values)(v) ? v : undefined),
      (o) => void o.choices(values),
    ),
  choiceOr: <const V extends string>(name: string, values: readonly V[], def: V, about: About) =>
    flag(
      `--${name} <${name}>`,
      t(about),
      values.join("|"),
      (v) => (isOneOf(values)(v) ? v : def),
      (o) => void o.choices(values),
    ),
  requiredChoice: <const V extends string>(name: string, values: readonly V[], about: About) =>
    flag(`--${name} <${name}>`, t(about), values.join("|"), oneOf(values), (o) => void o.choices(values).makeOptionMandatory()),
  /** Given any number of times, each kept in order. */
  many: (name: string, about: About) =>
    flag(`--${name} <${name}>`, t(about), "string", texts, (o) => void o.argParser((v: string, previous: unknown) => [...texts(previous), v]).default([])),
  /** text with a short alias as well (`-p`). */
  textAlias: (name: string, alias: string, about: About) => flag(`-${alias}, --${name} <${name}>`, t(about), "string", text),
};

export interface Example {
  readonly command: string;
  readonly description: string;
}

/** A command of the tree: one that runs (with its params), or a group of others. */
export type Spec =
  | {
      readonly kind: "leaf";
      readonly name: string;
      readonly about: string;
      readonly examples: readonly Example[];
      readonly params: Params;
      readonly run: (input: Readonly<Record<string, unknown>>, ctx: Ctx) => Promise<void>;
    }
  | { readonly kind: "group"; readonly name: string; readonly about: string; readonly children: readonly Spec[] };

export function command<P extends Params>(
  name: string,
  o: { readonly about: string; readonly examples?: readonly Example[]; readonly params?: P; readonly run: (input: Input<P>, ctx: Ctx) => Promise<void> | void },
): Spec {
  const params: Params = o.params ?? {};
  return {
    kind: "leaf",
    name,
    about: o.about,
    examples: o.examples ?? [],
    params,
    run: async (input, ctx) => {
      // The input was read param by param from P (readInput below), so it has P's shape.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built key by key from P's own params
      await o.run(input as Input<P>, ctx);
    },
  };
}

export const group = (name: string, about: string, children: readonly Spec[]): Spec => ({ kind: "group", name, about, children });

/** The parser said the line was written wrong (or asked for help, or the version), in the command it was reading. */
class ParseStop extends Error {
  override readonly name = "ParseStop";
  readonly error: CommanderError;
  readonly command: Command;
  constructor(error: CommanderError, command: Command) {
    super(error.message);
    this.error = error;
    this.command = command;
  }
}

const builtIns = [
  { flags: "--help, -h", about: "Show help information" },
  { flags: "--version", about: "Show version information" },
];

const pathOf = (cmd: Command): string[] => {
  const names: string[] = [];
  for (let at: Command | null = cmd; at; at = at.parent) names.unshift(at.name());
  return names;
};

const table = (rows: readonly { readonly left: string; readonly right: string }[], cap?: number) => {
  const widest = Math.max(...rows.map((r) => r.left.length)) + 4;
  const col = cap === undefined ? widest : Math.min(widest, cap);
  return rows.map(({ left, right }) => `  ${left.padEnd(Math.max(col, left.length + 1))}${right}`.trimEnd()).join("\n");
};

const optionLeft = (o: Option) => {
  const names = [o.long, o.short].filter((n): n is string => n !== undefined).join(", ");
  const type = typeOf.get(o);
  return o.isBoolean() || type === undefined ? names : `${names} ${type}`;
};

/** The help of a command, laid out as it always was: DESCRIPTION, USAGE, ARGUMENTS, FLAGS, GLOBAL FLAGS, SUBCOMMANDS, EXAMPLES. */
function helpOf(cmd: Command, examples: readonly Example[], globals: readonly GlobalFlag[]): string {
  const sections: string[] = [];
  const about = cmd.description();
  if (about) sections.push("DESCRIPTION", `  ${about}`, "");
  const args = cmd.registeredArguments;
  const usage = [
    pathOf(cmd).join(" "),
    ...(cmd.commands.length > 0 ? ["<subcommand>"] : []),
    "[flags]",
    ...args.map((a) => {
      const name = `${a.name()}${a.variadic ? "..." : ""}`;
      return a.required ? `<${name}>` : `[${name}]`;
    }),
  ].join(" ");
  sections.push("USAGE", `  ${usage}`, "");
  if (args.length > 0)
    sections.push(
      "ARGUMENTS",
      table(
        args.map((a) => ({
          left: `${a.name()}${a.variadic ? "..." : ""} ${typeOf.get(a) ?? "string"}`,
          right: `${a.description}${a.required ? "" : " (optional)"}`,
        })),
        25,
      ),
      "",
    );
  const global = new Set(["--help", "--version", ...globals.map((g) => g.flags.split(" ")[0])]);
  const own = cmd.options.filter((o) => o.long === undefined || !global.has(o.long));
  if (own.length > 0) sections.push("FLAGS", table(own.map((o) => ({ left: optionLeft(o), right: o.description }))), "");
  sections.push(
    "GLOBAL FLAGS",
    table([
      ...builtIns.map((b) => ({ left: b.flags, right: b.about })),
      ...globals.map((g) => {
        const name = g.flags.split(" ")[0] ?? g.flags;
        return { left: g.type === undefined ? name : `${name} ${g.type === "choice" ? (g.choices ?? []).join("|") : g.type}`, right: g.about ?? "" };
      }),
    ]),
    "",
  );
  if (cmd.commands.length > 0)
    sections.push(
      "SUBCOMMANDS",
      table(
        cmd.commands.map((c) => ({ left: c.name(), right: c.description() })),
        20,
      ),
      "",
    );
  if (examples.length > 0) {
    sections.push("EXAMPLES");
    examples.forEach((e, n) => {
      if (n > 0) sections.push("");
      sections.push(`  # ${e.description}`, `  ${e.command}`);
    });
    sections.push("");
  }
  if (sections.at(-1) === "") sections.pop();
  return sections.join("\n") + "\n";
}

/** The parser's tags, as the failure on stderr names them. */
const tagOf: Readonly<Record<string, string>> = {
  "commander.missingArgument": "MissingArgument",
  "commander.optionMissingArgument": "InvalidValue",
  "commander.missingMandatoryOptionValue": "MissingOption",
  "commander.unknownOption": "UnrecognizedOption",
  "commander.unknownCommand": "UnknownSubcommand",
  "commander.invalidArgument": "InvalidValue",
  "commander.excessArguments": "UnexpectedArgument",
  "commander.conflictingOption": "InvalidValue",
};

const said = (message: string) => {
  const m = message.replace(/^error: /u, "").trim();
  return m.charAt(0).toUpperCase() + m.slice(1);
};

/** Runs the command line: parses args against the tree, runs the command named, and gives back its exit code. Every
 * failure is answered here: on stderr as one JSON line (output.ts's printFailure), its code by kind. */
export async function runTree(
  root: Spec,
  o: {
    readonly args: readonly string[];
    readonly io: Io;
    readonly globals: readonly GlobalFlag[];
    readonly version: string;
    /** Prints a failure (printFailure); the code is the run's. */
    readonly fail: (io: Io, f: Failure) => void;
  },
): Promise<number> {
  const { io } = o;
  const settle = (cmd: Command, examples: readonly Example[]) => {
    cmd
      .helpCommand(false)
      .helpOption("-h, --help", "Show help information")
      .allowExcessArguments(false)
      .exitOverride((e) => {
        throw new ParseStop(e, cmd);
      })
      .configureOutput({
        writeOut: (s) => io.stdout(s),
        // What the parser would write on stderr (its message, help after a mistake) is said here instead, below.
        writeErr: () => undefined,
        outputError: () => undefined,
      })
      .configureHelp({ formatHelp: (c) => helpOf(c, examples, o.globals) });
  };
  const build = (spec: Spec): Command => {
    const cmd = new Command(spec.name).description(spec.about);
    if (spec.kind === "group") {
      settle(cmd, []);
      for (const child of spec.children) cmd.addCommand(build(child));
      return cmd;
    }
    settle(cmd, spec.examples);
    for (const p of Object.values(spec.params)) p.attach(cmd);
    cmd.action(async () => {
      const flags = globalsOf(cmd.optsWithGlobals(), io);
      const input: Record<string, unknown> = {};
      let at = 0;
      for (const [key, p] of Object.entries(spec.params)) input[key] = p.read(cmd, p.positional ? at++ : 0);
      await spec.run(input, { ...io, flags });
    });
    return cmd;
  };
  const program = build(root);
  program.version(o.version, "--version", "Show version information");
  for (const g of o.globals) {
    const option = new Option(g.flags, g.about);
    if (g.choices) option.choices(g.choices);
    program.addOption(option);
  }
  try {
    await program.parseAsync([...o.args], { from: "user" });
    return exit.ok;
  } catch (e) {
    if (e instanceof ParseStop) {
      const { code } = e.error;
      if (code === "commander.helpDisplayed" || code === "commander.version") return exit.ok;
      // A group run bare: asked what it holds, its help on stdout as with --help.
      if (code === "commander.help") {
        io.stdout(e.command.helpInformation());
        return exit.ok;
      }
      io.stderr(e.command.helpInformation());
      const path = pathOf(e.command).slice(1);
      const f = new Failure({
        code: exit.usage,
        tag: tagOf[code] ?? "InvalidValue",
        text: said(e.error.message),
        next: [{ say: t("cli.next.help"), run: [...path, "--help"] }],
      });
      o.fail(io, f);
      return f.code;
    }
    throw e;
  }
}
