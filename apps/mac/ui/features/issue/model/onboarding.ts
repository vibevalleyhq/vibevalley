import { z } from "zod";

import type { IssueStatus, RepoSummary, RuntimeInfo } from "@vibevalley/protocol";

import type { IconName } from "../../../design/icons";
import { defineStored } from "../../../infra/state/stored";
import { type Lane, laneStatus } from "./cards";

export function isRuntimeReady(runtime: RuntimeInfo): boolean {
  return runtime.installation.status === "available" && runtime.settings.enabled;
}

export interface OnboardingReadiness {
  readonly reposReady: boolean;
  readonly repoCount: number;
  readonly runtimesReady: boolean;
  readonly readyRuntimeCount: number;
  readonly issuesReady: boolean;
  readonly issueCount: number;
  readonly completedCount: number;
  readonly totalCount: 3;
  readonly allReady: boolean;
}

export function computeOnboardingReadiness(input: {
  readonly repos: readonly RepoSummary[];
  readonly runtimes: readonly RuntimeInfo[];
  readonly issueCount: number;
}): OnboardingReadiness {
  const repoCount = input.repos.length;
  const readyRuntimeCount = input.runtimes.filter(isRuntimeReady).length;
  const issueCount = Math.max(0, input.issueCount);
  const reposReady = repoCount > 0;
  const runtimesReady = readyRuntimeCount > 0;
  const issuesReady = issueCount > 0;
  const completedCount = Number(reposReady) + Number(runtimesReady) + Number(issuesReady);
  return {
    reposReady,
    repoCount,
    runtimesReady,
    readyRuntimeCount,
    issuesReady,
    issueCount,
    completedCount,
    totalCount: 3,
    allReady: completedCount === 3,
  };
}

export type StarterTemplateId = "bug" | "feature" | "refactor";

export interface StarterTemplate {
  readonly id: StarterTemplateId;
  readonly icon: IconName;
  readonly titleKey:
    | "web.issue.onboarding.templates.bug.title"
    | "web.issue.onboarding.templates.feature.title"
    | "web.issue.onboarding.templates.refactor.title";
  readonly descKey: "web.issue.onboarding.templates.bug.desc" | "web.issue.onboarding.templates.feature.desc" | "web.issue.onboarding.templates.refactor.desc";
  readonly promptKey:
    | "web.issue.onboarding.templates.bug.prompt"
    | "web.issue.onboarding.templates.feature.prompt"
    | "web.issue.onboarding.templates.refactor.prompt";
}

export const starterTemplates: readonly StarterTemplate[] = [
  {
    id: "bug",
    icon: "bug",
    titleKey: "web.issue.onboarding.templates.bug.title",
    descKey: "web.issue.onboarding.templates.bug.desc",
    promptKey: "web.issue.onboarding.templates.bug.prompt",
  },
  {
    id: "feature",
    icon: "idea",
    titleKey: "web.issue.onboarding.templates.feature.title",
    descKey: "web.issue.onboarding.templates.feature.desc",
    promptKey: "web.issue.onboarding.templates.feature.prompt",
  },
  {
    id: "refactor",
    icon: "diff",
    titleKey: "web.issue.onboarding.templates.refactor.title",
    descKey: "web.issue.onboarding.templates.refactor.desc",
    promptKey: "web.issue.onboarding.templates.refactor.prompt",
  },
];

export const workflowGuideCollapsed = defineStored("board.workflowGuide.collapsed", z.boolean(), false);

export interface WorkflowStage {
  readonly lane: Lane;
  readonly status: IssueStatus;
  readonly descKey: "web.issue.guide.stage.todo" | "web.issue.guide.stage.working" | "web.issue.guide.stage.waiting" | "web.issue.guide.stage.closed";
}

export const workflowStages: readonly WorkflowStage[] = [
  { lane: "todo", status: laneStatus.todo, descKey: "web.issue.guide.stage.todo" },
  { lane: "working", status: laneStatus.working, descKey: "web.issue.guide.stage.working" },
  { lane: "waiting", status: laneStatus.waiting, descKey: "web.issue.guide.stage.waiting" },
  { lane: "closed", status: laneStatus.closed, descKey: "web.issue.guide.stage.closed" },
];

export interface EmptyLaneGuide {
  readonly icon: IconName;
  readonly titleKey:
    | "web.issue.board.emptyGuide.todoTitle"
    | "web.issue.board.emptyGuide.workingTitle"
    | "web.issue.board.emptyGuide.waitingTitle"
    | "web.issue.board.emptyGuide.closedTitle";
  readonly bodyKey:
    | "web.issue.board.emptyGuide.todoBody"
    | "web.issue.board.emptyGuide.workingBody"
    | "web.issue.board.emptyGuide.waitingBody"
    | "web.issue.board.emptyGuide.closedBody";
}

export const emptyLaneGuide: Record<Lane, EmptyLaneGuide> = {
  todo: {
    icon: "add",
    titleKey: "web.issue.board.emptyGuide.todoTitle",
    bodyKey: "web.issue.board.emptyGuide.todoBody",
  },
  working: {
    icon: "play",
    titleKey: "web.issue.board.emptyGuide.workingTitle",
    bodyKey: "web.issue.board.emptyGuide.workingBody",
  },
  waiting: {
    icon: "diff",
    titleKey: "web.issue.board.emptyGuide.waitingTitle",
    bodyKey: "web.issue.board.emptyGuide.waitingBody",
  },
  closed: {
    icon: "check",
    titleKey: "web.issue.board.emptyGuide.closedTitle",
    bodyKey: "web.issue.board.emptyGuide.closedBody",
  },
};
