import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Option, Predicate, Result, Schema } from "effect";

import type { Locale } from "@vibevalley/i18n";

/** A home where nobody set one: ~/.vibevalley, with a desktop channel's suffix (-beta, -alpha, -dev) after it. */
export const defaultHome = (suffix = "", home = homedir()) => join(home, `.vibevalley${suffix}`);

/** The home a program uses: VIBEVALLEY_HOME, else the default one. */
export const homeOf = (env: Readonly<Record<string, string | undefined>> = process.env) => env.VIBEVALLEY_HOME || defaultHome();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Someone else's process: there all the same.
    return Predicate.hasProperty(e, "code") && e.code === "EPERM";
  }
};

/** server.json: where the server using this home listens, and its process. */
const Announcement = Schema.fromJsonString(Schema.Struct({ url: Schema.String, pid: Schema.Finite }));
const announcement = Schema.decodeUnknownOption(Announcement);

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Says where this server listens, for as long as it does; the function it returns takes it back. */
export function announce(home: string, url: string): () => void {
  const path = join(home, "server.json");
  writeFileSync(path, Result.getOrThrow(Schema.encodeResult(Announcement)({ url, pid: process.pid })) + "\n", { mode: 0o600 });
  return () => {
    const said = Option.flatMap(Option.fromNullishOr(read(path)), announcement);
    if (Option.isSome(said) && said.value.pid === process.pid) rmSync(path, { force: true });
  };
}

/** Where the server using this home listens; undefined when none says so or it has stopped. */
export function announced(home: string): string | undefined {
  const said = Option.flatMap(Option.fromNullishOr(read(join(home, "server.json"))), announcement);
  return Option.isSome(said) && alive(said.value.pid) ? said.value.url : undefined;
}

const settings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ locale: Schema.optionalKey(Schema.String) })));

/** The language saved in the home's settings.json (the server's, apps/server/src/setting), for a program that speaks before it reaches the server. */
export function savedLocale(home: string): Locale {
  const saved = Option.flatMap(Option.fromNullishOr(read(join(home, "settings.json"))), settings);
  return Option.isSome(saved) && saved.value.locale === "en" ? "en" : "zh";
}

/** The desktop app's socket in the home: the command line asks the app over it (desktopControl). */
export const controlSocketOf = (home: string) => join(home, "desktop.sock");

/** auth.json: the server the command line signed in to (`vibevalley auth login`) and the key it was given. */
const SignIn = Schema.Struct({ server: Schema.String, key: Schema.String, device: Schema.String });
export type SignIn = typeof SignIn.Type;
const SignInJson = Schema.fromJsonString(SignIn);
const signIn = Schema.decodeUnknownOption(SignInJson);

/** The server this home signed in to and its key; undefined when it has not. */
export function signedIn(home: string): SignIn | undefined {
  return Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(read(join(home, "auth.json"))), signIn));
}

/** Keeps the sign-in where only this user reads it: the key is the user's own, and works from anywhere. */
export function keepSignIn({ home, ...given }: SignIn & { readonly home: string }): void {
  writeFileSync(join(home, "auth.json"), Result.getOrThrow(Schema.encodeResult(SignInJson)(given)) + "\n", { mode: 0o600 });
}

export function forgetSignIn(home: string): void {
  rmSync(join(home, "auth.json"), { force: true });
}
