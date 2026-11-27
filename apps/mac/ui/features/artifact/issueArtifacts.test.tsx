import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Artifact, type ArtifactId, type ArtifactType, type Issue, type IssueId, userId } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

function makeArtifact(id: string, title: string, artifactType: ArtifactType = "docs", issue?: IssueId): Artifact {
  return {
    id: artifactId(id),
    title,
    artifactType,
    isDefault: false,
    ...(issue ? { issue } : {}),
    by: userId,
    byName: "You",
    version: 1,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  };
}

function setupInteractiveArtifacts(initial: Artifact[], route: string) {
  const store = [...initial];
  const updateCalls: { id: string; issue?: string }[] = [];
  const createCalls: { title: string; artifactType: ArtifactType; issue?: string }[] = [];

  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) fake.respond(op, answer);

  fake.respond("artifact.list", (payload: unknown) => {
    const p = (payload ?? {}) as { issue?: string; artifactType?: ArtifactType };
    return store.filter((a) => (p.issue === undefined || a.issue === p.issue) && (p.artifactType === undefined || a.artifactType === p.artifactType));
  });

  fake.respond("artifact.update", (payload: unknown) => {
    const p = payload as { id: ArtifactId; title?: string; issue?: string };
    updateCalls.push({ id: p.id, ...(p.issue !== undefined ? { issue: p.issue } : {}) });
    const idx = store.findIndex((a) => a.id === p.id);
    if (idx < 0) return { bizCode: 100004, message: "not found" };
    const current = store[idx];
    const next: Artifact = {
      ...current,
      ...(p.title !== undefined ? { title: p.title } : {}),
    };
    if (p.issue !== undefined) {
      if (p.issue === "") {
        delete (next as { issue?: IssueId }).issue;
      } else {
        (next as { issue?: IssueId }).issue = p.issue as IssueId;
      }
    }
    store[idx] = next;
    return next;
  });

  fake.respond("artifact.create", (payload: unknown) => {
    const p = payload as { title: string; artifactType: ArtifactType; issue?: string };
    createCalls.push({ title: p.title, artifactType: p.artifactType, ...(p.issue !== undefined ? { issue: p.issue } : {}) });
    const made = makeArtifact(`art-created-${store.length + 1}`, p.title, p.artifactType, p.issue as IssueId | undefined);
    store.unshift(made);
    return made;
  });

  return { fake, store, updateCalls, createCalls };
}

test("IssueArtifacts in TodoDetail supports searchable linking, creating a new linked artifact, and unlinking", async () => {
  setLocale("en");
  const todoIssue: Issue =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo")!;

  const { fake, updateCalls, createCalls } = setupInteractiveArtifacts(
    [makeArtifact("art-alpha", "Auth Spec", "docs"), makeArtifact("art-beta", "Release Board", "whiteboard")],
    `/issues/${todoIssue.id}`,
  );

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-artifacts") === 1 && app.count("id:issue-artifacts-empty") === 1);

  // Search and link an existing artifact via Select(cover={false}).
  const trigger = app.layout("id:issue-artifact-link-picker-trigger");
  expect(trigger).not.toBeNull();
  await app.press("id:issue-artifact-link-picker-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-link-picker-search") === 1);
  const searchBox = app.layout("id:issue-artifact-link-picker-search");
  expect(searchBox).not.toBeNull();
  // Popup opens without covering the trigger (`cover={false}`).
  const triggerBottom = trigger!.y + trigger!.height;
  const searchBottom = searchBox!.y + searchBox!.height;
  expect(searchBox!.y >= triggerBottom - 1 || searchBottom <= trigger!.y + 1).toBe(true);

  await app.type("id:issue-artifact-link-picker-search", "Auth");
  await fake.pump(app);
  expect(app.texts()).toContain("Auth Spec · Document");
  expect(app.texts()).not.toContain("Release Board · Whiteboard");
  await app.press("text:Auth Spec · Document");

  await fake.pumpUntil(app, () => app.count("id:issue-artifact-row-art-alpha") === 1);
  expect(updateCalls).toContainEqual({ id: "art-alpha", issue: todoIssue.id });

  // Create a new linked artifact directly from TodoDetail.
  await app.press("id:issue-artifact-new");
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-new-dialog") === 1);
  await app.type("id:issue-artifact-new-title", "Rollout Checklist");
  await app.press("id:issue-artifact-new-submit");

  await fake.pumpUntil(app, () => createCalls.length === 1 && app.count("id:issue-artifact-new-dialog") === 0);
  expect(createCalls[0]).toEqual({ title: "Rollout Checklist", artifactType: "docs", issue: todoIssue.id });
  await fake.pumpUntil(app, () => app.texts().includes("Rollout Checklist"));

  // Unlink the first artifact via artifact.update({ id, issue: "" }).
  await app.press("id:issue-artifact-unlink-art-alpha");
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-row-art-alpha") === 0);
  expect(updateCalls).toContainEqual({ id: "art-alpha", issue: "" });
});

test("IssueArtifacts in IssueDetail links and unlinks artifacts", async () => {
  setLocale("en");
  const allIssues = scenarios.typical.state.board.issues;
  const activeIssue: Issue = allIssues.find((i) => (i.status === "in_progress" || i.status === "in_review") && !allIssues.some((c) => c.parent === i.id))!;

  const { fake, updateCalls } = setupInteractiveArtifacts(
    [makeArtifact("art-linked-1", "Existing Spec", "docs", activeIssue.id), makeArtifact("art-pool-1", "Design Tokens", "design-system")],
    `/issues/${activeIssue.id}`,
  );

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-row-art-linked-1") === 1);

  await app.press("id:issue-artifact-link-picker-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-link-picker-search") === 1);
  await app.type("id:issue-artifact-link-picker-search", "Tokens");
  await fake.pump(app);
  await app.press("text:Design Tokens · Design System");

  await fake.pumpUntil(app, () => app.count("id:issue-artifact-row-art-pool-1") === 1);
  expect(updateCalls).toContainEqual({ id: "art-pool-1", issue: activeIssue.id });

  await app.press("id:issue-artifact-unlink-art-linked-1");
  await fake.pumpUntil(app, () => app.count("id:issue-artifact-row-art-linked-1") === 0);
  expect(updateCalls).toContainEqual({ id: "art-linked-1", issue: "" });
});
