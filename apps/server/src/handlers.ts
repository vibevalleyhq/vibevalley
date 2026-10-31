// Each handler only forwards to the service that owns the rule.

import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/http";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import type { ApiError, Handlers } from "@vibevalley/protocol/api";

import { Agent } from "./agent/agent.ts";
import { Artifact } from "./artifact/artifact.ts";
import { owner } from "./base/actor.ts";
import { Channel } from "./channel/chat.ts";
import { Connector } from "./connector/connector.ts";
import { Core } from "./core/core.ts";
import { Cron } from "./cron/cron.ts";
import { missing, lookIn, reasonOf, refused, orMissing } from "./errors.ts";
import { Game } from "./game/game.ts";
import { requestKeys } from "./http/requestKey.ts";
import { ServerConfig } from "./infra/config.ts";
import { Issue } from "./issue/issue.ts";
import { deviceHeader, Lan } from "./lan/lan.ts";
import { Memory } from "./memory/memory.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { Project } from "./project/project.ts";
import { Runtime } from "./runtime/runtime.ts";
import { Session } from "./session/session.ts";
import { Setting } from "./setting/setting.ts";
import { Task } from "./task/task.ts";
import { Voice } from "./voice/voice.ts";

export const handlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const core = yield* Core;
  const setting = yield* Setting;
  const agents = yield* Agent;
  const projects = yield* Project;
  const memory = yield* Memory;
  const runtimes = yield* Runtime;
  const sessions = yield* Session;
  const channels = yield* Channel;
  const artifacts = yield* Artifact;
  const crons = yield* Cron;
  const issues = yield* Issue;
  const tasks = yield* Task;
  const orchestrator = yield* Orchestrator;
  const game = yield* Game;
  const lan = yield* Lan;
  const voice = yield* Voice;
  const connectors = yield* Connector;
  /** An issue's id, with the fields the owner changed beside an act saved first. */
  const edited = (ref: string, edit: T.IssueUpdate | undefined) => Effect.tap(issues.idOf(ref), (id) => (edit ? issues.edit(id, edit, owner) : Effect.void));
  /** The issue with the seq read once its service has applied its facts: the first frame at that seq shows the change. */
  const applied = (issue: Effect.Effect<T.Issue, ApiError>) => Effect.map(issue, (i): T.AppliedIssue => ({ ...i, seq: core.seq() }));
  const createOnce = requestKeys<T.AppliedIssue>();
  const statusOnce = requestKeys<T.AppliedIssue>();
  const threadOnce = requestKeys<string>();
  const memoryOnce = requestKeys<T.Memory>();
  const done: Handlers = {
    "server.health.get": () => Effect.succeed({ ok: true, version: config.version }),
    "orchestrator.open": () => core.open(),
    "orchestrator.stop": ({ agent }) => orchestrator.stop(agent),
    "game.achievement.list": () => Effect.sync(game.achievements),
    "voice.grant.create": () => voice.session(),
    "voice.grant.renew": (body) => voice.renew(body.channel, body.uid),
    "voice.call.start": (body) => voice.start(body.channel, body.uid, body.about),
    "voice.call.stop": (body) => voice.stop(body.agentId),
    "voice.call.hear": (body) => voice.heard(body.agentId, body.text, body.agent ?? "", body.sendKey ?? ""),
    "voice.call.say": (body) => voice.said(body.agentId, body.text),
    "voice.dictate": (body) => voice.dictate(body.audio, body.format),
    "voice.moss.verify": (body) => voice.verifyMoss(body.key ?? ""),
    "voice.hear": (body) => voice.heardCurrent(body.text, body.agent ?? "", body.sendKey ?? ""),
    "connector.list": () => connectors.list(),
    "connector.login": ({ id, ...body }) => connectors.login(id, body),
    "connector.verify": ({ id, ...body }) => connectors.verify(id, body.code),
    "connector.logout": ({ id }) => connectors.logout(id),
    "connector.channel.set": ({ id, ...body }) => connectors.setChannel(id, body.channel),
    "lan.get": () => Effect.sync(lan.status),
    "lan.update": (body) => lan.setOpen(body.open),
    "lan.pairing.start": () => lan.startPairing(),
    "lan.pairing.stop": () => Effect.sync(lan.stopPairing),
    "lan.pairing.previewStop": () => Effect.sync(lan.previewStopPairing),
    "lan.pairing.answer": (body) => lan.answer(body.allow),
    "lan.device.delete": ({ id }) => lan.forget(id),
    "lan.device.previewDelete": ({ id }) => lan.previewForget(id),
    "lan.pair": (body) => lan.pair(body.code, body.name),
    // Only the lan listener says a device, by a header it never takes from the device.
    "lan.me.get": () =>
      Effect.flatMap(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
        lan.me(Option.getOrUndefined(Option.map(request, (r) => r.headers[deviceHeader]))),
      ),
    "game.title.set": (body) => game.chooseTitle(body.achievement, body.tier),
    "github.refresh": () => Effect.tap(projects.refreshGitHub(), () => issues.refreshPullRequests),
    "orchestrator.eval.create": (body) => orchestrator.markWrong(body.on, body.want, body.agent),
    "channel.message.send": (body) =>
      Effect.andThen(
        Effect.sync(() => body.station !== undefined && game.want(body.station)),
        orchestrator.say(
          body.text,
          { ...(body.agent ? { agent: body.agent } : {}), ...(body.project ? { project: body.project } : {}) },
          body.id,
          body.sendKey ?? "",
          {
            ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
            ...(body.attachments ? { attachments: body.attachments } : {}),
            ...(body.blocks ? { blockRefs: body.blocks } : {}),
          },
        ),
      ),
    "setting.get": () => Effect.sync(setting.status),
    "setting.validate": (body) => Effect.sync(() => setting.validate(body)),
    "setting.update": (body) => setting.save(body).pipe(Effect.mapError((e) => refused(e.message))),
    "github.get": () => Effect.sync(projects.githubStatus),
    "project.list": () => projects.summaries(),
    "project.validate": (body) => Effect.sync(() => projects.validate(body)),
    "project.create": (body) =>
      projects.create(body).pipe(
        Effect.flatMap(projects.summary),
        Effect.mapError((e) => refused(e.message)),
      ),
    "project.language.list": ({ id }) =>
      projects.languages(id).pipe(
        Effect.mapError((e) => refused(e.message)),
        orMissing(t("server.projectRef", { id }), [lookIn.project]),
      ),
    "project.activity.get": ({ id }) => projects.activity(id).pipe(orMissing(t("server.projectRef", { id }), [lookIn.project])),
    "agent.list": () => Effect.sync(agents.all),
    "agent.create": (body) => agents.create(body),
    "agent.update": (agent) => agents.save(agent),
    "agent.delete": ({ id }) => agents.remove(id),
    "agent.previewDelete": ({ id }) => agents.previewRemove(id),
    "agent.template.list": () => agents.templates(),
    "agent.template.install": ({ id }) => agents.installTemplate(id),
    "agent.template.update": ({ agent }) => agents.updateFromTemplate(agent),
    "agent.template.add": ({ path }) => agents.addTemplate(path),
    "agent.template.delete": ({ id }) => agents.removeTemplate(id),
    "agent.template.previewDelete": ({ id }) => agents.previewRemoveTemplate(id),
    "skill.list": () => Effect.sync(agents.skills),
    "skill.create": (body) => agents.createSkill(body),
    "skill.update": (skill) => agents.saveSkill(skill),
    "skill.delete": ({ id }) => agents.removeSkill(id),
    "skill.previewDelete": ({ id }) => agents.previewRemoveSkill(id),
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, project, text }) => memory.recallOf(agent, project ?? "", text ?? ""),
    "memory.search": ({ agent, project, text }) =>
      memory.search({ agent: agent ? (agents.named(agent)?.id ?? agent) : "", project: project ?? "", text: text ?? "", kind: "", limit: 0 }),
    "memory.create": ({ agent, ...body }) => memoryOnce(body.requestKey, memory.remember({ agent, text: body.text, project: body.project ?? "", by: owner })),
    "memory.delete": ({ agent, memory: id }) => memory.forget(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForget(agent, id),
    "orchestrator.archive.list": ({ agent, q }) => memory.archive(agent || defaultOrchestrator, q ?? ""),
    "orchestrator.archive.get": ({ agent, name }) =>
      memory.archiveFile(agent || defaultOrchestrator, name).pipe(
        Effect.filterOrFail(
          (text) => text !== undefined,
          () => missing(t("server.archiveRef", { name }), [lookIn.archive]),
        ),
      ),
    "runtime.list": () => runtimes.list(),
    "runtime.refresh": ({ id }) => runtimes.refresh(id).pipe(orMissing("runtime " + id, [lookIn.runtime])),
    "runtime.setting.update": ({ id, ...body }) => runtimes.update(id, body).pipe(orMissing("runtime " + id, [lookIn.runtime])),
    "agent.validate": (body) => Effect.forEach(body.agents, (agent) => Effect.map(runtimes.problemsOf(agent), (problems) => ({ id: agent.id, problems }))),
    "session.stop": ({ id }) => (sessions.find(id) ? Effect.asVoid(sessions.stop(id)) : Effect.fail(missing(t("server.helperRef", { id }), [lookIn.session]))),
    "session.list": ({ agent }) => sessions.list(agent ?? ""),
    "session.get": ({ id }) => sessions.get(id).pipe(orMissing(t("server.helperRef", { id }), [lookIn.session])),
    "session.event.list": ({ id, run }) => Effect.map(sessions.events(id, run ?? ""), (events) => events ?? []),
    "channel.create": (body) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.project ?? ""), (c) => c.id),
    "channel.update": ({ id, ...body }) => channels.updateChannel(id, body),
    "channel.archive.set": ({ id, on }) => channels.archive(id, on),
    "channel.delete": ({ id }) => channels.removeChannel(id),
    "channel.previewDelete": ({ id }) => channels.previewRemoveChannel(id),
    "channel.notify.set": ({ id, notify }) => channels.setNotify(id, notify),
    "channel.direct.create": ({ agent }) => issues.talkWith(agent),
    "channel.markUnread": ({ id, number }) => channels.markUnread(id, number),
    "channel.list": () => channels.list(),
    "channel.unread.list": () => channels.unread(ownerId),
    "channel.default.set": ({ id }) => channels.makeDefault(id),
    "channel.message.list": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": ({ id, ...body }) => channels.markRead(id, body.number).pipe(Effect.mapError((e) => missing(reasonOf(e), [lookIn.channel]))),
    "channel.message.update": ({ id, text, attachments }) => channels.edit(id, text, attachments),
    "channel.message.delete": ({ id }) => channels.remove(id),
    "channel.message.previewDelete": ({ id }) => channels.previewRemove(id),
    "channel.message.search": ({ text, channel }) => channels.search(text, channel),
    "channel.reaction.set": ({ id, emoji, on }) => channels.react(id, ownerId, emoji, on),
    "channel.pin.set": ({ id, on }) => channels.pin(id, on),
    "channel.pin.list": ({ id }) => channels.pins(id),
    "channel.thread.create": ({ id, requestKey }) => threadOnce(requestKey, channels.threadUnder(id)),
    "channel.attachment.create": (upload) => channels.attach(upload),
    "artifact.list": ({ channel, issue }) =>
      Effect.flatMap(issue ? issues.idOf(issue) : Effect.succeed(undefined), (id) =>
        artifacts.list({ ...(channel ? { channel } : {}), ...(id ? { issue: id } : {}) }),
      ),
    "artifact.get": ({ id }) => artifacts.get(id),
    "artifact.content.get": ({ id, version }) => Effect.map(artifacts.content(id, version), (c) => ({ version: c.version, content: c.content })),
    "artifact.create": (req) =>
      Effect.flatMap(req.issue ? issues.idOf(req.issue) : Effect.succeed(undefined), (issue) =>
        artifacts.create({ from: ownerId, by: ownerId }, { ...req, ...(issue ? { issue } : {}) }),
      ),
    "artifact.version.create": (req) => artifacts.version({ from: ownerId, by: ownerId }, req),
    "artifact.update": ({ id, title }) => artifacts.rename(id, title),
    "artifact.delete": ({ id }) => artifacts.remove(id),
    "artifact.previewDelete": ({ id }) => artifacts.previewRemove(id),
    "artifact.block.list": ({ id }) => artifacts.blocks(id),
    "artifact.submit": ({ id, ...body }) => artifacts.submit(id, ownerId, body),
    "artifact.block.create": ({ id, ...body }) => artifacts.insertBlock(id, ownerId, body),
    "artifact.block.update": ({ id, ...body }) => artifacts.updateBlock(id, ownerId, body),
    "artifact.block.delete": ({ id, ...body }) => artifacts.deleteBlock(id, ownerId, body),
    "artifact.block.previewDelete": ({ id, block }) => artifacts.previewDeleteBlock(id, { block }),
    "artifact.suggestion.list": ({ id }) => artifacts.suggestions(id),
    "artifact.suggestion.create": ({ id, ...body }) => artifacts.suggest(id, ownerId, body),
    "artifact.suggestion.accept": ({ id, suggestion }) => artifacts.acceptSuggestion(id, suggestion, ownerId),
    "artifact.suggestion.reject": ({ id, suggestion }) => artifacts.rejectSuggestion(id, suggestion, ownerId),
    "artifact.markdown.get": ({ id }) => Effect.map(artifacts.markdown(id), (markdown) => ({ markdown })),
    "artifact.demo": ({ id }) => artifacts.demo(id, agents.agents()),
    "cron.create": (body) => crons.add(body, owner),
    "cron.list": () => Effect.sync(crons.list),
    "cron.update": ({ id, ...body }) => (body.enabled === undefined ? Effect.void : Effect.asVoid(crons.setEnabled(id, body.enabled))),
    "cron.delete": ({ id }) => Effect.asVoid(crons.remove(id)),
    "cron.previewDelete": ({ id }) => crons.previewRemove(id),
    "issue.list": (filter) => issues.query(filter),
    "issue.review": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.review(id, body)),
    "issue.split": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => tasks.splitIssueOf(id, body.title ?? "", body.tasks)),
    "issue.history.list": () => issues.history(),
    "issue.get": ({ id }) => issues.get(id),
    "issue.run.list": ({ id }) => Effect.flatMap(issues.get(id), (issue) => sessions.runs(issue.id)),
    "issue.timeline.get": ({ id }) => issues.timeline(id),
    "issue.create": ({ requestKey, ...body }) => createOnce(requestKey, applied(issues.add(body))),
    "issue.update": ({ id: ref, ...body }) => applied(Effect.flatMap(issues.idOf(ref), (id) => issues.edit(id, body, owner))),
    "issue.delete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.remove(id)),
    "issue.previewDelete": ({ id }) => issues.previewRemove(id),
    "issue.status.previewUpdate": ({ id, ...body }) =>
      issues.previewStatus(id, body.status, body.text ?? "", body.assignee ? { assignee: body.assignee } : {}, body.edit),
    "issue.refine": ({ id: ref, ...body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.refine(id, body.text ?? "", channels.defaultChannel())),
    "issue.status.update": ({ id: ref, ...body }) =>
      statusOnce(
        body.requestKey,
        applied(
          Effect.flatMap(edited(ref, body.edit), (id) =>
            issues.setStatus(id, body.status, body.text ?? "", channels.defaultChannel(), owner, body.assignee ? { assignee: body.assignee } : {}),
          ),
        ),
      ),
    "issue.comment.create": ({ id: ref, ...body }) =>
      Effect.flatMap(issues.idOf(ref), (id) => Effect.map(issues.comment(id, body.text, body.sendKey ?? ""), (): T.Applied => ({ seq: core.seq() }))),
    "issue.diff.get": ({ id }) => issues.changes(id, owner),
    "project.template.list": ({ id }) => issues.templates(id),
    "graph.split": (body) => tasks.split(body.goal, body.project, body.agent ?? "", owner),
    "graph.task.update": ({ id, task, ...body }) => tasks.editTask(id, task, body, owner),
    "graph.task.delete": ({ id, task }) => tasks.removeTask(id, task, owner),
    "graph.task.previewDelete": ({ id, task }) => tasks.previewRemoveTask(id, task),
    "graph.act": ({ id, ...body }) => tasks.act(id, body.action, owner),
    "graph.task.act": ({ id, task, ...body }) => tasks.taskAct(id, task, body.action, owner),
    "graph.diff.get": ({ id }) => tasks.changes(id),
    "graph.event.list": ({ id }) => tasks.events(id),
    "graph.list": () => Effect.sync(tasks.graphs),
    "graph.get": ({ id }) => tasks.graph(id),
  };
  return done;
});
