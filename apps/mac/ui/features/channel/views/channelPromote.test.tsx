import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Artifact, type Channel, type ChatMessage, type Issue } from "@vibevalley/protocol";
import { artifactId, issueId, messageId } from "@vibevalley/protocol/schema";

import { responses as artifactResponses } from "../../../fixtures/artifacts";
import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { buildPromotedArtifactDraft, buildPromotedIssueDraft, messageSourcePath } from "../model/promote";

test("promote helpers carry /chat/<channel>?m=<seq> back-links, body, and attachments", () => {
  setLocale("en");
  const channel: Channel = {
    id: "design",
    type: "channel",
    default: false,
    category: "",
    notify: "all",
    description: "",
    subjectKind: null,
    replies: 0,
    title: "design",
    name: "design",
    repo: "vibevalley",
    at: SCENARIO_NOW,
  };
  const msg: ChatMessage = {
    id: messageId("m-42"),
    number: 42,
    channel: "design",
    from: "user",
    actor: { kind: "user", id: "user", name: "You" },
    name: "You",
    kind: "chat",
    text: "Fix login redirect loop\nCheck session expiry handling.",
    at: SCENARIO_NOW,
    revision: 1,
    mentions: [],
    spoken: false,
    reactions: [],
    attachments: [
      { id: "att-img", name: "flow.png", type: "image/png", size: 1200 },
      { id: "att-pdf", name: "spec.pdf", type: "application/pdf", size: 4200 },
    ],
    embeds: [],
    outcome: null,
  };

  expect(messageSourcePath(msg)).toBe("/chat/design?m=42");

  const issueDraft = buildPromotedIssueDraft(msg, channel);
  expect(issueDraft.repo).toBe("vibevalley");
  expect(issueDraft.attachmentFiles).toHaveLength(2);
  expect(issueDraft.text).toContain("Fix login redirect loop");
  expect(issueDraft.text).toContain("/chat/design?m=42");

  const artDraft = buildPromotedArtifactDraft(msg, channel);
  expect(artDraft.title).toBe("Fix login redirect loop");
  expect(artDraft.backLink).toBe("/chat/design?m=42");
  expect(artDraft.content).toContain("![flow.png](/api/v1/attachment/att-img)");
  expect(artDraft.content).toContain("[spec.pdf](/api/v1/attachment/att-pdf)");
  expect(artDraft.content).toContain("/chat/design?m=42");
});

test("MessageTools overflow promotes a channel message to NewIssue with body, attachments, and back-link", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) fake.respond(op, answer);

  const createdIssues: { title?: string; description?: string; attachments?: string[] }[] = [];
  const baseIssue = scenarios.typical.state.board.issues[0];
  fake.respond("issue.create", (payload: unknown): Issue => {
    const p = payload as { title?: string; description?: string; attachments?: string[] };
    createdIssues.push(p);
    return {
      ...baseIssue,
      id: issueId("i-promoted-1"),
      number: 99,
      title: p.title ?? "Promoted",
      description: p.description ?? "",
    };
  });
  fake.respond("issue.refine", (payload: unknown): Issue => {
    const p = payload as { id: string; text?: string };
    return { ...baseIssue, id: issueId(p.id), number: 99, title: p.text ?? "Promoted" };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-head") === 1);

  await app.hover("text:设计稿和录屏在这，参考 https://example.com/design");
  await fake.pumpUntil(app, () => app.count("id:message-tool-more") === 1);
  await app.press("id:message-tool-more");
  await fake.pumpUntil(app, () => app.count("id:more-promote-issue") === 1);
  await app.press("id:more-promote-issue");

  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  const prefilled = app.value("id:issue-new-text");
  expect(prefilled).toContain("设计稿和录屏在这");
  expect(prefilled).toContain("/chat/general?m=7");
  expect(app.count("id:issue-attachment-tile")).toBe(4);

  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => createdIssues.length === 1);
  expect(createdIssues[0]?.title).toContain("/chat/general?m=7");
  expect(createdIssues[0]?.attachments).toEqual(["a1", "a2", "a3", "a4"]);
});

test("MessageTools overflow saves a channel message as an artifact with channel source and back-link", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) fake.respond(op, answer);

  const createdArtifacts: { title?: string; artifactType?: Artifact["artifactType"]; channel?: string; content?: string }[] = [];
  const sampleArtifact: Artifact = {
    id: artifactId("art-saved-msg"),
    title: "设计稿和录屏在这，参考 https://example.com/design",
    artifactType: "docs",
    isDefault: false,
    channel: "general",
    said: { channel: "general", number: 12 },
    by: "user",
    byName: "You",
    version: 1,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW,
    updated: SCENARIO_NOW,
  };
  fake.respond("artifact.create", (payload: unknown) => {
    const p = payload as { title?: string; artifactType?: Artifact["artifactType"]; channel?: string; content?: string };
    createdArtifacts.push(p);
    return {
      ...sampleArtifact,
      title: p.title ?? sampleArtifact.title,
      artifactType: p.artifactType ?? "docs",
      channel: p.channel ?? "general",
    };
  });
  fake.respond("artifact.get", () => sampleArtifact);
  fake.respond("artifact.list", () => [sampleArtifact]);
  fake.respond("artifact.file.list", () => ({ artifactId: sampleArtifact.id, seq: 1, files: [] }));

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-head") === 1);

  await app.hover("text:设计稿和录屏在这，参考 https://example.com/design");
  await fake.pumpUntil(app, () => app.count("id:message-tool-more") === 1);
  await app.press("id:message-tool-more");
  await fake.pumpUntil(app, () => app.count("id:more-save-artifact") === 1);
  await app.press("id:more-save-artifact");

  await fake.pumpUntil(app, () => app.count("id:save-artifact-dialog") === 1);
  expect(app.value("id:save-artifact-title")).toContain("设计稿和录屏在这");
  const content = app.value("id:save-artifact-content");
  expect(content).toContain("/chat/general?m=7");
  expect(content).toContain("/api/v1/attachment/a3");

  await app.press("id:save-artifact-submit");
  await fake.pumpUntil(app, () => createdArtifacts.length === 1);
  expect(createdArtifacts[0]).toMatchObject({
    artifactType: "docs",
    channel: "general",
  });
  expect(createdArtifacts[0]?.content ?? "").toContain("/chat/general?m=7");
  await fake.pumpUntil(app, () => app.count("id:artifact-header") === 1);
});
