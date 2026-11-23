import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { RepoSummary, RuntimeInfo } from "@vibevalley/protocol";

import { computeOnboardingReadiness, emptyLaneGuide, isRuntimeReady, starterTemplates, workflowStages } from "./onboarding";

function makeRepo(name: string): RepoSummary {
  return {
    name,
    path: `/Users/tester/code/${name}`,
    git: true,
    last: 1_000,
    maxSessions: 2,
    pullRequest: { available: false, reason: "" },
  };
}

function sampleRuntime(id: string, status: RuntimeInfo["installation"]["status"], enabled: boolean): RuntimeInfo {
  const installation: RuntimeInfo["installation"] =
    status === "available"
      ? { status: "available", via: "executable", command: `/usr/local/bin/${id}`, version: "1.0.0" }
      : status === "unsupported"
        ? { status: "unsupported", reason: "missing key" }
        : status === "checking"
          ? { status: "checking" }
          : { status: "not_found" };
  return {
    id,
    preset: {
      id,
      label: id,
      blurb: "",
      look: { species: "bear", outfit: "farmer", orchestrator: null, build: "biped", head: "rounded", body: "#fff", trim: "#000", hat: "#ff0", eye: "#0ff" },
    },
    support: { steer: true, refused: {}, capabilities: [], inProcess: false },
    installation,
    models: null,
    usage: null,
    skills: null,
    mcpServers: null,
    tools: null,
    settings: { enabled, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
    stop: "",
    checkedAt: 1_000,
  };
}

test("isRuntimeReady requires both available installation and enabled setting", () => {
  expect(isRuntimeReady(sampleRuntime("claude", "available", true))).toBe(true);
  expect(isRuntimeReady(sampleRuntime("claude", "available", false))).toBe(false);
  expect(isRuntimeReady(sampleRuntime("codex", "not_found", true))).toBe(false);
  expect(isRuntimeReady(sampleRuntime("opencode", "unsupported", true))).toBe(false);
  expect(isRuntimeReady(sampleRuntime("checking", "checking", true))).toBe(false);
});

test("computeOnboardingReadiness tracks 0/3 -> 1/3 -> 2/3 -> 3/3 progression", () => {
  const step0 = computeOnboardingReadiness({ repos: [], runtimes: [sampleRuntime("opencode", "not_found", true)], issueCount: 0 });
  expect(step0).toEqual({
    reposReady: false,
    repoCount: 0,
    runtimesReady: false,
    readyRuntimeCount: 0,
    issuesReady: false,
    issueCount: 0,
    completedCount: 0,
    totalCount: 3,
    allReady: false,
  });

  const step1 = computeOnboardingReadiness({
    repos: [makeRepo("vibevalley")],
    runtimes: [sampleRuntime("claude", "available", false)],
    issueCount: 0,
  });
  expect(step1.reposReady).toBe(true);
  expect(step1.repoCount).toBe(1);
  expect(step1.runtimesReady).toBe(false);
  expect(step1.completedCount).toBe(1);
  expect(step1.allReady).toBe(false);

  const step2 = computeOnboardingReadiness({
    repos: [makeRepo("vibevalley"), makeRepo("site")],
    runtimes: [sampleRuntime("claude", "available", true), sampleRuntime("codex", "available", true), sampleRuntime("opencode", "not_found", true)],
    issueCount: 0,
  });
  expect(step2.reposReady).toBe(true);
  expect(step2.repoCount).toBe(2);
  expect(step2.runtimesReady).toBe(true);
  expect(step2.readyRuntimeCount).toBe(2);
  expect(step2.issuesReady).toBe(false);
  expect(step2.completedCount).toBe(2);
  expect(step2.allReady).toBe(false);

  const step3 = computeOnboardingReadiness({
    repos: [makeRepo("vibevalley")],
    runtimes: [sampleRuntime("claude", "available", true)],
    issueCount: 4,
  });
  expect(step3.issuesReady).toBe(true);
  expect(step3.issueCount).toBe(4);
  expect(step3.completedCount).toBe(3);
  expect(step3.allReady).toBe(true);
});

test("starterTemplates, workflowStages, and emptyLaneGuide cover all required entries", () => {
  expect(starterTemplates.map((tpl) => tpl.id)).toEqual(["bug", "feature", "refactor"]);
  expect(workflowStages.map((s) => s.lane)).toEqual(["todo", "working", "waiting", "closed"]);
  expect(Object.keys(emptyLaneGuide)).toEqual(["todo", "working", "waiting", "closed"]);
});
