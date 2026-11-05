import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { planRelease, type Stage } from "./release-plan.ts";

const root = resolve(import.meta.dirname, "..");
const baseline = "apps/server/db/migrations/0001_schema.up.sql";

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** git's exit code, for the commands whose answer is it (diff --quiet, a ref that may not be there). */
const gitStatus = (...args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" }).status;
const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: root, stdio: "inherit" }).status === 0;

function fail(why: string): never {
  console.error(`release: ${why}`);
  process.exit(1);
}

const stage = process.argv[2];
if (stage !== "alpha" && stage !== "beta" && stage !== "final") fail("say which: vp run release alpha | beta | final");
const asked: Stage = stage;

if (git("status", "--porcelain") !== "") fail("the working tree has changes. Fix: commit or stash them; a tag names a commit");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (!run("git", "fetch", "--quiet", "--tags", "origin")) fail("could not fetch from origin. Fix: check the network and `git remote -v`");
if (gitStatus("rev-parse", "--verify", "--quiet", `origin/${branch}`) !== 0) fail(`origin has no ${branch}. Fix: push it first`);
if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${branch}`))
  fail(`${branch} is not where origin's is. Fix: git pull, or push what is only here, so the tag names what everyone has`);

const planned = planRelease(asked, git("tag", "--list", "v*").split("\n"), branch);
if (!planned.ok) fail(planned.why);
const plan = planned.plan;
if (plan.cut && gitStatus("rev-parse", "--verify", "--quiet", `origin/${plan.branch}`) === 0)
  fail(`origin has ${plan.branch} already. Fix: git switch ${plan.branch}, and tag the next beta there`);

// Within a beta line the farm never starts over: the database's baseline is the one its first beta had.
if (plan.schemaSince !== undefined && gitStatus("diff", "--quiet", plan.schemaSince, "HEAD", "--", baseline) !== 0)
  fail(
    `the database's baseline (${baseline}) changed since ${plan.schemaSince}: every farm on this beta line would start over. Fix: take the change off ${branch} and leave it on main, for the next minor`,
  );

if (asked !== "alpha" && !run("vp", "run", "release:verify")) fail("release:verify failed (above). Fix it on main, then bring the fix here");

// What it has that the version before it had not: a release counts from the release before it, alphas and betas included.
const previousArgs = ["describe", "--tags", "--abbrev=0", ...(asked === "final" ? ["--exclude", "*-*"] : []), "HEAD"];
const previous = gitStatus(...previousArgs) === 0 ? git(...previousArgs) : undefined;
const shown = 30;
const commits = git("log", "--format=%h %s", previous === undefined ? "HEAD" : `${previous}..HEAD`)
  .split("\n")
  .filter((l) => l !== "");
const listed = [...commits.slice(0, shown), ...(commits.length > shown ? [`… and ${commits.length - shown} more`] : [])].map((l) => `  ${l}`).join("\n");
const newFarm = previous !== undefined && gitStatus("diff", "--quiet", previous, "HEAD", "--", baseline) !== 0;

console.log(`
${plan.tag}${plan.cut ? `, on ${plan.branch} cut from main` : ` on ${plan.branch}`} at ${git("rev-parse", "--short", "HEAD")}
Since ${previous ?? "the first commit"}:
${listed || "  (nothing)"}
${newFarm ? `\nIts database's baseline differs from ${previous}'s: every farm that updates to it starts over (the old one is kept aside).\n` : ""}`);

if (!process.stdin.isTTY) fail("it asks before it pushes: run it in a terminal");
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const answer = await prompt.question(`Tag ${plan.tag} and push it to origin? [y/N] `);
prompt.close();
if (!/^y(?:es)?$/iu.test(answer.trim())) {
  console.log("Nothing tagged or pushed.");
  process.exit(0);
}

if (plan.cut && !run("git", "switch", "--create", plan.branch)) fail(`could not cut ${plan.branch}`);
if (!run("git", "tag", "--annotate", plan.tag, "--message", `VibeValley ${plan.version}`)) fail(`could not tag ${plan.tag}`);
if (!run("git", "push", "origin", ...(plan.cut ? [plan.branch] : []), plan.tag))
  fail(`the push failed: ${plan.tag} is tagged here only. Fix: git push origin ${plan.cut ? `${plan.branch} ` : ""}${plan.tag}`);

console.log(`
Pushed ${plan.tag}. The release workflow builds its draft from it; publish the draft on GitHub${asked === "final" ? "" : ", ticking pre-release"}.${
  plan.cut ? `\nFixes for ${plan.version.replace(/-.*$/u, "")} go into main first, then onto ${plan.branch} (git cherry-pick).` : ""
}`);
