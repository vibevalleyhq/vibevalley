import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

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
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
};

/** server.json: where the server using this home listens, and its process. */
const Announcement = z.object({ url: z.string(), pid: z.number() });

/** text as JSON decoded by schema; undefined when it is missing, not JSON, or not that shape (a file another version left). */
const decoded = <A>(schema: z.ZodType<A>, text: string | undefined): A | undefined => {
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: as good as no file.
    return undefined;
  }
  const got = schema.safeParse(json);
  return got.success ? got.data : undefined;
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // No such file (or unreadable): nothing said there.
    return undefined;
  }
};

/** Says where this server listens, for as long as it does; the function it returns takes it back. */
export function announce(home: string, url: string): () => void {
  const path = join(home, "server.json");
  writeFileSync(path, JSON.stringify({ url, pid: process.pid }) + "\n", { mode: 0o600 });
  return () => {
    const said = decoded(Announcement, read(path));
    if (said?.pid === process.pid) rmSync(path, { force: true });
  };
}

/** Where the server using this home listens; undefined when none says so or it has stopped. */
export function announced(home: string): string | undefined {
  const said = decoded(Announcement, read(join(home, "server.json")));
  return said && alive(said.pid) ? said.url : undefined;
}

const Settings = z.object({ locale: z.exactOptional(z.string()) });

/** The language saved in the home's settings.json (the server's, apps/server/src/setting), for a program that speaks before it reaches the server. */
export function savedLocale(home: string): Locale {
  return decoded(Settings, read(join(home, "settings.json")))?.locale === "en" ? "en" : "zh";
}

/** The desktop app's socket in the home: the command line asks the app over it (desktopControl). */
export const controlSocketOf = (home: string) => join(home, "desktop.sock");

/** auth.json: the server the command line signed in to (`vibevalley auth login`) and the key it was given. */
const SignIn = z.object({ server: z.string(), key: z.string(), device: z.string() });
export type SignIn = z.infer<typeof SignIn>;

/** The server this home signed in to and its key; undefined when it has not. */
export function signedIn(home: string): SignIn | undefined {
  return decoded(SignIn, read(join(home, "auth.json")));
}

/** Keeps the sign-in where only this user reads it: the key is the user's own, and works from anywhere. */
export function keepSignIn({ home, ...given }: SignIn & { readonly home: string }): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ server: given.server, key: given.key, device: given.device }) + "\n", { mode: 0o600 });
}

export function forgetSignIn(home: string): void {
  rmSync(join(home, "auth.json"), { force: true });
}
