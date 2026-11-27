import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { RepoSummary } from "@vibevalley/protocol";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

test("ReposPage mounts a local folder via folder picker, distinguishes local mounts, opens Workspace, and unmounts", async () => {
  setLocale("zh");
  let repos: RepoSummary[] = [
    {
      name: "vibevalley",
      path: "/Users/farmer/code/vibevalley",
      git: true,
      external: false,
      last: SCENARIO_NOW - 20_000,
      maxSessions: 3,
      pullRequest: { available: true, reason: "" },
    },
  ];
  const mountedRepo: RepoSummary = {
    name: "external-app",
    path: "/Users/farmer/workspace/external-app",
    git: true,
    external: true,
    last: SCENARIO_NOW - 10_000,
    maxSessions: 2,
    pullRequest: { available: false, reason: "Not a GitHub repository" },
  };
  const fake = fakeHost(scenarios.typical, { route: "/repos", globalShell: true });
  fake.respond("repo.list", () => repos);
  fake.respond("host.pickFolder", () => ({
    path: mountedRepo.path,
    name: mountedRepo.name,
    git: false,
  }));
  fake.respond("repo.mount", (payload: unknown) => {
    const req = payload as { path: string; name?: string; initGit?: boolean };
    expect(req.path).toBe(mountedRepo.path);
    expect(req.initGit).toBe(true);
    repos = [...repos, mountedRepo];
    return mountedRepo;
  });
  fake.respond("repo.unmount", (payload: unknown) => {
    const req = payload as { id: string };
    expect(req.id).toBe(mountedRepo.name);
    repos = repos.filter((r) => r.name !== req.id);
    return null;
  });

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:repos-page") === 1 && app.count("id:mount-local-repo") === 1);
  expect(app.count("id:open-workspace")).toBe(0);
  expect(app.count("id:repos-empty")).toBe(1);
  expect(app.count("id:repos-empty-mount")).toBe(0);
  expect(app.texts()).toContain(t("web.repo.selectPrompt"));

  await app.press("id:mount-local-repo");
  await fake.pumpUntil(app, () => app.count("id:new-repo-dialog") === 1 && app.count("id:repo-pick-folder") === 1);

  await app.press("id:repo-pick-folder");
  await fake.pumpUntil(app, () => app.value("id:repo-local-path") === mountedRepo.path);
  expect(app.value("id:repo-name")).toBe(mountedRepo.name);

  await app.press("id:submit");
  await fake.pumpUntil(app, () => app.count("id:repo-overview") === 1 && app.count("id:repo-origin-badge") === 1);
  expect(app.texts()).toContain(t("web.repo.badgeLocal"));
  expect(app.count("id:repo-open-workspace")).toBe(1);
  expect(app.count("id:repo-unmount")).toBe(1);

  // Open in Workspace forwards activate_path for the mounted folder.
  await app.press("id:repo-open-workspace");
  await fake.pump(app);
  expect(fake.acts.some((p) => p.type === "activate_path" && p.path === mountedRepo.path)).toBe(true);

  // Two-step unmount removes from server registry and returns to /repos.
  await app.press("id:repo-unmount");
  await fake.pumpUntil(app, () => app.count("id:repo-unmount-sure") === 1);
  await app.press("id:repo-unmount-sure");
  await fake.pumpUntil(app, () => app.count("id:repos-empty") === 1);
  expect(repos.some((r) => r.name === mountedRepo.name)).toBe(false);
});

test("ReposPage displays SSOT repo health status badge and breakdown card", async () => {
  setLocale("en");
  const repos: RepoSummary[] = [
    {
      name: "alpha",
      path: "/Users/farmer/code/alpha",
      git: true,
      external: false,
      last: Math.floor((SCENARIO_NOW - 20_000) / 1000),
      maxSessions: 3,
      pullRequest: { available: true, reason: "" },
      health: {
        repo: "alpha",
        status: "off_track",
        reasons: ["stuck_issues", "overdue_issues"],
        openIssues: 4,
        inProgressIssues: 1,
        inReviewIssues: 0,
        blockedIssues: 1,
        stuckIssues: 1,
        askingIssues: 0,
        failedChecks: 0,
        overdueIssues: 2,
        lastCommitAt: SCENARIO_NOW - 20_000,
        evaluatedAt: SCENARIO_NOW,
      },
    },
    {
      name: "beta",
      path: "/Users/farmer/code/beta",
      git: true,
      external: false,
      last: Math.floor((SCENARIO_NOW - 10_000) / 1000),
      maxSessions: 3,
      pullRequest: { available: true, reason: "" },
      health: {
        repo: "beta",
        status: "on_track",
        reasons: ["healthy"],
        openIssues: 0,
        inProgressIssues: 0,
        inReviewIssues: 0,
        blockedIssues: 0,
        stuckIssues: 0,
        askingIssues: 0,
        failedChecks: 0,
        overdueIssues: 0,
        lastCommitAt: SCENARIO_NOW - 10_000,
        evaluatedAt: SCENARIO_NOW,
      },
    },
  ];
  const fake = fakeHost(scenarios.typical, { route: "/repos/alpha", locale: "en" });
  fake.respond("repo.list", () => repos);

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:repo-health-badge") === 1 && app.count("id:repo-health-card") === 1);
  expect(app.count("id:repo-health-card-badge")).toBe(0);
  expect(app.shows("id:repo-health-badge >> text:Off track")).toBe(true);
  expect(app.shows("id:repo-health-card >> text:Open")).toBe(true);
  expect(app.texts().some((line) => line === "Open 4")).toBe(false);
  expect(app.texts().some((line) => line.includes("Stuck issues need attention"))).toBe(true);
  expect(app.texts().some((line) => line.includes("Overdue issues past due date"))).toBe(true);

  // On-track repos omit redundant reason tautology and duplicate card badge.
  await app.press("id:list-row-beta");
  await fake.pumpUntil(app, () => app.shows("id:repo-health-badge >> text:On track"));
  expect(app.count("id:repo-health-card-badge")).toBe(0);
  expect(app.texts().some((line) => line.includes("Healthy and moving smoothly"))).toBe(false);
});
