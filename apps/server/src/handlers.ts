import { t } from "@vibevalley/i18n";
// Each handler only forwards to the service that owns the rule.

import { defaultOrchestrator, type IssueUpdate, ownerId } from "@vibevalley/protocol";
import type { Handlers } from "@vibevalley/protocol/api";
import { Agents } from "./agent/agent.ts";
import { missing, lookIn, reasonOf, refused } from "./errors.ts";
import { Projects } from "./project/project.ts";
import { Effect, Option } from "effect";
import { Config } from "./base/config.ts";
import { Core } from "./core/core.ts";
import { Artifacts } from "./artifact/artifact.ts";
import { Channels } from "./channel/chat.ts";
import { Issues } from "./issue/issue.ts";
import { Memories } from "./memory/memory.ts";
import { Runtimes } from "./runtime/runtime.ts";
import { Crons } from "./cron/cron.ts";
import { Sessions } from "./session/session.ts";
import { Setting } from "./setting/setting.ts";
import { Tasks } from "./task/task.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { Game } from "./game/game.ts";
import { deviceHeader, Lan } from "./lan/lan.ts";
import { Voice } from "./voice/voice.ts";
import { Connectors } from "./connector/connector.ts";
import { HttpServerRequest } from "effect/http";
import { owner } from "./base/actor.ts";

export const handlers = Effect.gen(function* () {
  const config = yield* Config;
  const core = yield* Core;
  const setting = yield* Setting;
  const agents = yield* Agents;
  const projects = yield* Projects;
  const memory = yield* Memories;
  const runtimes = yield* Runtimes;
  const sessions = yield* Sessions;
  const channels = yield* Channels;
  const artifacts = yield* Artifacts;
  const crons = yield* Crons;
  const issues = yield* Issues;
  const tasks = yield* Tasks;
  const orchestrator = yield* Orchestrator;
  const game = yield* Game;
  const lan = yield* Lan;
  const voice = yield* Voice;
  const connectors = yield* Connectors;
  /** An issue's id, with the fields the owner changed beside an act saved first. */
  const edited = (ref: string, edit: IssueUpdate | undefined) => Effect.tap(issues.idOf(ref), (id) => (edit ? issues.edit(id, edit, owner) : Effect.void));
  const done: Handlers = {
    "server.health.get": () => Effect.succeed({ ok: true, version: config.version }),
    "orchestrator.open": () => core.open(),
    "orchestrator.stop": ({ agent }) => orchestrator.stop(agent),
    "game.achievement.list": () => Effect.sync(game.achievements),
    "voice.session.create": () => voice.session(),
    "voice.session.renew": (body) => voice.renew(body.channel, body.uid),
    "voice.agent.start": (body) => voice.start(body.channel, body.uid, body.about),
    "voice.agent.stop": (body) => voice.stop(body.agentId),
    "voice.agent.hear": (body) => voice.heard(body.agentId, body.text, body.agent ?? "", body.sendKey ?? ""),
    "voice.agent.say": (body) => voice.said(body.agentId, body.text),
    "voice.dictate": (body) => voice.dictate(body.audio, body.format),
    "voice.moss.check": (body) => voice.checkMoss(body.key ?? ""),
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
    "github.refresh": () => Effect.flatMap(projects.refreshGitHub(), (status) => Effect.as(issues.refreshPullRequests, status)),
    "orchestrator.eval.create": (body) => orchestrator.markWrong(body.on, body.want, body.agent),
    "channel.message.send": (body) =>
      Effect.andThen(
        Effect.sync(() => body.station !== undefined && game.want(body.station)),
        orchestrator.say(
          body.text,
          { ...(body.agent ? { agent: body.agent } : {}), ...(body.project ? { project: body.project } : {}) },
          body.id,
          body.sendKey ?? "",
          { ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}), ...(body.attachments ? { attachments: body.attachments } : {}) },
        ),
      ),
    "setting.get": () => Effect.sync(setting.status),
    "setting.check": (body) => Effect.sync(() => setting.check(body)),
    "setting.update": (body) => setting.save(body).pipe(Effect.mapError((e) => refused(e.message))),
    "github.get": () => Effect.sync(projects.githubStatus),
    "project.list": () => projects.summaries(),
    "project.check": (body) => Effect.sync(() => projects.check(body)),
    "project.create": (body) =>
      projects.create(body).pipe(
        Effect.flatMap(projects.summary),
        Effect.mapError((e) => refused(e.message)),
      ),
    "project.language.list": ({ id }) =>
      projects.languages(id).pipe(
        Effect.mapError((e) => refused(e.message)),
        Effect.flatMap((l) => (l ? Effect.succeed(l) : Effect.fail(missing(t("server.projectRef", { id }), [lookIn.project])))),
      ),
    "project.activity.get": ({ id }) =>
      Effect.flatMap(projects.activity(id), (a) => (a ? Effect.succeed(a) : Effect.fail(missing(t("server.projectRef", { id }), [lookIn.project])))),
    "agent.list": () => Effect.sync(agents.all),
    "agent.create": (body) => agents.createAgent(body),
    "agent.update": (agent) => agents.saveAgent(agent),
    "agent.delete": ({ id }) => agents.deleteAgent(id),
    "agent.previewDelete": ({ id }) => agents.previewDeleteAgent(id),
    "agent.template.list": () => Effect.sync(agents.templates),
    "agent.template.install": ({ id }) => agents.installTemplate(id),
    "agent.template.update": ({ agent }) => agents.updateFromTemplate(agent),
    "agent.template.add": ({ path }) => agents.addTemplate(path),
    "agent.template.delete": ({ id }) => agents.deleteTemplate(id),
    "agent.template.previewDelete": ({ id }) => agents.previewDeleteTemplate(id),
    "skill.list": () => Effect.sync(agents.skills),
    "skill.create": (body) => agents.createSkill(body),
    "skill.update": (skill) => agents.saveSkill(skill),
    "skill.delete": ({ id }) => agents.deleteSkill(id),
    "skill.previewDelete": ({ id }) => agents.previewDeleteSkill(id),
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, project, text }) => memory.recallOf(agent, project ?? "", text ?? ""),
    "memory.search": ({ agent, project, text }) =>
      memory.search({ agent: agent ? (agents.named(agent)?.id ?? agent) : "", project: project ?? "", text: text ?? "", kind: "", limit: 0 }),
    "memory.create": ({ agent, ...body }) => memory.remember({ agent, text: body.text, project: body.project ?? "", by: owner }),
    "memory.delete": ({ agent, memory: id }) => memory.forgetOf(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForgetOf(agent, id),
    "orchestrator.archive.list": ({ agent, q }) => Effect.sync(() => memory.archive(agent || defaultOrchestrator, q ?? "")),
    "orchestrator.archive.get": ({ agent, name }) =>
      Effect.suspend(() => {
        const text = memory.archiveFile(agent || defaultOrchestrator, name);
        return text !== undefined ? Effect.succeed(text) : Effect.fail(missing(t("server.archiveRef", { name }), [lookIn.archive]));
      }),
    "runtime.list": () => Effect.sync(runtimes.list),
    "runtime.refresh": ({ id }) =>
      Effect.flatMap(runtimes.refresh(id), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id, [lookIn.runtime])))),
    "runtime.setting.update": ({ id, ...body }) =>
      Effect.flatMap(runtimes.update(id, body), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id, [lookIn.runtime])))),
    "agent.check": (body) => Effect.forEach(body.agents, (agent) => Effect.map(runtimes.check(agent), (problems) => ({ id: agent.id, problems }))),
    "session.stop": ({ id }) => (sessions.find(id) ? Effect.asVoid(sessions.stop(id)) : Effect.fail(missing(t("server.helperRef", { id }), [lookIn.session]))),
    "session.list": ({ agent }) => sessions.list(agent ?? ""),
    "session.get": ({ id }) =>
      Effect.flatMap(sessions.get(id), (s) => (s ? Effect.succeed(s) : Effect.fail(missing(t("server.helperRef", { id }), [lookIn.session])))),
    "session.event.list": ({ id, run }) => Effect.sync(() => sessions.events(id, run ?? "") ?? []),
    "channel.create": (body) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.project ?? ""), (c) => c.id),
    "channel.update": ({ id, ...body }) => channels.updateChannel(id, body),
    "channel.archive.toggle": ({ id }) => channels.archive(id),
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
    "channel.reaction.toggle": ({ id, emoji }) => channels.react(id, ownerId, emoji),
    "channel.pin.toggle": ({ id }) => channels.pin(id),
    "channel.pin.list": ({ id }) => channels.pins(id),
    "channel.thread.create": ({ id }) => channels.threadUnder(id),
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
    "artifact.block.create": ({ id, ...body }) => artifacts.appendBlock(id, ownerId, body),
    "artifact.block.update": ({ id, ...body }) => artifacts.updateBlock(id, ownerId, body),
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
    "issue.get": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.get(id)),
    "issue.run.list": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => Effect.andThen(issues.get(id), sessions.runs(id))),
    "issue.timeline.get": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.timeline(id)),
    "issue.create": (body) => issues.add(body),
    "issue.update": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.edit(id, body, owner)),
    "issue.delete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.remove(id)),
    "issue.previewDelete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.previewRemove(id)),
    "issue.status.previewUpdate": ({ id: ref, ...body }) =>
      Effect.flatMap(issues.idOf(ref), (id) =>
        issues.previewStatus(id, body.status, body.text ?? "", body.assignee ? { assignee: body.assignee } : {}, body.edit),
      ),
    "issue.refine": ({ id: ref, ...body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.refine(id, body.text ?? "", channels.defaultChannel())),
    "issue.status.update": ({ id: ref, ...body }) =>
      Effect.flatMap(edited(ref, body.edit), (id) =>
        issues.setStatus(id, body.status, body.text ?? "", channels.defaultChannel(), owner, body.assignee ? { assignee: body.assignee } : {}),
      ),
    "issue.comment.create": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.comment(id, body.text, body.sendKey ?? "")),
    "issue.diff.get": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.changes(id, owner)),
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
