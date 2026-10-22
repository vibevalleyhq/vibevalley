// Each handler only forwards to the service that owns the rule.

import { docOwner, type IssueUpdate } from "@vibevalley/protocol";
import type { Handlers } from "@vibevalley/protocol/api";
import { Agents } from "./agent/agent.ts";
import { missing, reasonOf, refused } from "./errors.ts";
import { Projects } from "./project/project.ts";
import { Effect } from "effect";
import { Settings } from "./base/config.ts";
import { Core } from "./core/core.ts";
import { Channels } from "./channel/chat.ts";
import { Docs } from "./doc/doc.ts";
import { Issues } from "./issue/issue.ts";
import { Memories } from "./memory/memory.ts";
import { Runtimes } from "./runtime/runtime.ts";
import { Recurrences } from "./recurrence/recurrence.ts";
import { Sessions } from "./session/session.ts";
import { Setting } from "./setting/setting.ts";
import { Tasks } from "./task/task.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { Game } from "./game/game.ts";
import { deviceHeader, Lan } from "./lan/lan.ts";
import { Voice } from "./voice/voice.ts";
import { Connectors } from "./connector/connector.ts";
import { HttpServerRequest } from "effect/http";

export const handlers = Effect.gen(function* () {
  const config = yield* Settings;
  const core = yield* Core;
  const setting = yield* Setting;
  const agents = yield* Agents;
  const projects = yield* Projects;
  const memory = yield* Memories;
  const docs = yield* Docs;
  const runtimes = yield* Runtimes;
  const sessions = yield* Sessions;
  const channels = yield* Channels;
  const recurrences = yield* Recurrences;
  const issues = yield* Issues;
  const tasks = yield* Tasks;
  const orchestrator = yield* Orchestrator;
  const game = yield* Game;
  const lan = yield* Lan;
  const voice = yield* Voice;
  const connectors = yield* Connectors;
  /** An issue's id, with the fields the owner changed beside an act saved first. */
  const edited = (ref: string, edit: IssueUpdate | undefined) => Effect.tap(issues.idOf(ref), (id) => (edit ? issues.edit(id, edit) : Effect.void));
  const done: Handlers = {
    "server.health": () => Effect.succeed({ ok: true, version: config.version }),
    "orchestrator.open": () => core.open(),
    "orchestrator.stop": () => orchestrator.stop(),
    "game.achievements": () => Effect.sync(game.achievements),
    "voice.session": () => voice.session(),
    "voice.renew": ({ body }) => voice.renew(body.channel, body.uid),
    "voice.start": ({ body }) => voice.start(body.channel, body.uid, body.about),
    "voice.stop": ({ body }) => voice.stop(body.agentId),
    "voice.heard": ({ body }) => voice.heard(body.agentId, body.text, body.agent ?? "", body.sendKey ?? ""),
    "voice.said": ({ body }) => voice.said(body.agentId, body.text),
    "voice.dictate": ({ body }) => voice.dictate(body.audio, body.format),
    "orchestrator.hear": ({ body }) => voice.heardCurrent(body.text, body.agent ?? "", body.sendKey ?? ""),
    "connector.list": () => connectors.list(),
    "connector.login": ({ id, body }) => connectors.login(id, body),
    "connector.verify": ({ id, body }) => connectors.verify(id, body.code),
    "connector.logout": ({ id }) => connectors.logout(id),
    "connector.channel": ({ id, body }) => connectors.setChannel(id, body.channel),
    "lan.status": () => Effect.sync(lan.status),
    "lan.update": ({ body }) => lan.setOpen(body.open),
    "lan.startPairing": () => lan.startPairing(),
    "lan.stopPairing": () => Effect.sync(lan.stopPairing),
    "lan.answerPairing": ({ body }) => lan.answer(body.allow),
    "lan.deleteDevice": ({ id }) => lan.forget(id),
    "lan.pair": ({ body }) => lan.pair(body.code, body.name),
    // Only the lan listener says a device, by a header it never takes from the device.
    "lan.me": () =>
      Effect.flatMap(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
        lan.me(request._tag === "Some" ? (request.value.headers[deviceHeader] as string | undefined) : undefined),
      ),
    "game.chooseTitle": ({ body }) => game.chooseTitle(body.achievement, body.tier),
    "github.refresh": () => Effect.flatMap(projects.refreshGitHub(), (status) => Effect.as(issues.refreshPullRequests, status)),
    "orchestrator.markWrong": ({ body }) => orchestrator.markWrong(body.on, body.want),
    "channel.say": ({ body }) =>
      Effect.andThen(
        Effect.andThen(
          Effect.sync(() => body.station !== undefined && game.want(body.station)),
          core.open(),
        ),
        orchestrator.say(
          body.text,
          { ...(body.agent ? { agent: body.agent } : {}), ...(body.project ? { project: body.project } : {}) },
          body.conversation,
          body.sendKey ?? "",
        ),
      ),
    "setting.load": () => Effect.sync(setting.status),
    "setting.check": ({ body }) => Effect.sync(() => ({ ...setting.check(body), github: projects.githubStatus() })),
    "setting.save": ({ body }) => setting.save(body).pipe(Effect.mapError((e) => refused(e.message))),
    "github.status": () => Effect.sync(projects.githubStatus),
    "project.list": () => projects.summaries(),
    "project.check": ({ body }) => Effect.sync(() => projects.check(body)),
    "project.create": ({ body }) =>
      projects.create(body).pipe(
        Effect.flatMap(projects.summary),
        Effect.mapError((e) => refused(e.message)),
      ),
    "project.languages": ({ id }) =>
      projects.languages(id).pipe(
        Effect.mapError((e) => refused(e.message)),
        Effect.flatMap((l) => (l ? Effect.succeed(l) : Effect.fail(missing("项目 " + id)))),
      ),
    "project.activity": ({ id }) => Effect.flatMap(projects.activity(id), (a) => (a ? Effect.succeed(a) : Effect.fail(missing("项目 " + id)))),
    "agent.list": () => Effect.sync(agents.all),
    "agent.create": ({ body }) => agents.createAgent(body),
    "agent.save": ({ id, body }) => (body.id !== id ? Effect.fail(refused(`路径里的档案 ${id} 和请求里的 ${body.id} 不是一个`)) : agents.saveAgent(body)),
    "agent.delete": ({ id }) => agents.deleteAgent(id),
    "skill.list": () => Effect.sync(agents.skills),
    "skill.create": ({ body }) => agents.createSkill(body),
    "skill.save": ({ id, body }) => (body.id !== id ? Effect.fail(refused(`路径里的技能 ${id} 和请求里的 ${body.id} 不是一个`)) : agents.saveSkill(body)),
    "skill.delete": ({ id }) => agents.deleteSkill(id),
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, project, text }) => memory.recallOf(agent, project ?? "", text ?? ""),
    "memory.create": ({ agent, body }) => memory.remember({ agent, text: body.text, project: body.project ?? "", by: "owner" }),
    "memory.delete": ({ agent, memory: id }) => memory.forgetOf(agent, id),
    "orchestrator.listArchive": ({ q }) => Effect.sync(() => memory.archive(q ?? "")),
    "orchestrator.getArchive": ({ name }) =>
      Effect.suspend(() => {
        const text = memory.archiveFile(name);
        return text !== undefined ? Effect.succeed(text) : Effect.fail(missing("旧账 " + name));
      }),
    "runtime.list": () => Effect.sync(runtimes.list),
    "runtime.refresh": ({ id }) => Effect.flatMap(runtimes.refresh(id), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id)))),
    "runtime.update": ({ id, body }) =>
      Effect.flatMap(runtimes.update(id, body), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id)))),
    "agent.check": ({ body }) => Effect.forEach(body.agents, (agent) => Effect.map(runtimes.check(agent), (issues) => ({ id: agent.id, issues }))),
    "session.stop": ({ id }) => (sessions.find(id) ? Effect.asVoid(sessions.stop(id)) : Effect.fail(missing("帮工 " + id))),
    "session.list": ({ agent }) => sessions.list(agent ?? ""),
    "session.get": ({ id }) => Effect.flatMap(sessions.get(id), (s) => (s ? Effect.succeed(s) : Effect.fail(missing("帮工 " + id)))),
    "session.events": ({ id, run }) => Effect.sync(() => sessions.events(id, run ?? "") ?? []),
    "channel.create": ({ body }) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.project ?? ""), (c) => c.id),
    "channel.update": ({ id, body }) => channels.updateChannel(id, body.description, body.project),
    "channel.history": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": ({ id, body }) => channels.markRead(id, body.number).pipe(Effect.mapError((e) => missing(reasonOf(e)))),
    "recurrence.create": ({ body }) => recurrences.add(body, "owner", true),
    "recurrence.list": () => Effect.sync(recurrences.list),
    "recurrence.update": ({ id, body }) => (body.enabled === undefined ? Effect.void : Effect.asVoid(recurrences.setEnabled(id, body.enabled))),
    "recurrence.delete": ({ id }) => Effect.asVoid(recurrences.remove(id)),
    "issue.list": () => issues.list(),
    "issue.history": () => issues.history(),
    "issue.get": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.get(id)),
    "issue.runs": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => Effect.andThen(issues.get(id), sessions.runs(id))),
    "issue.timeline": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.timeline(id)),
    "issue.create": ({ body }) => issues.add(body),
    "issue.update": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.edit(id, body)),
    "issue.move": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.move(id, body.before ?? "")),
    "issue.delete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.remove(id)),
    "issue.act": ({ id, body }) => issues.act(id, body, channels.general()),
    "issue.review": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.review(id, body)),
    "issue.refine": ({ id: ref, body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.refine(id, body.text ?? "", channels.general())),
    "issue.dispatch": ({ id: ref, body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.dispatchQueued(id)),
    "issue.status": ({ id: ref, body }) =>
      Effect.flatMap(edited(ref, body.edit), (id) => issues.setStatus(id, body.status, body.text ?? "", channels.general())),
    "issue.comment": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.comment(id, body.text, body.sendKey ?? "")),
    "issue.changes": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.changes(id, "owner")),
    "issue.resolve": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.resolve(id)),
    "project.templates": ({ id }) => issues.templates(id),
    "graph.split": ({ body }) => tasks.split(body.goal, body.project, body.agent ?? "", "user"),
    "graph.updateTask": ({ id, task, body }) => tasks.editTask(id, task, body, "user"),
    "graph.deleteTask": ({ id, task }) => tasks.removeTask(id, task, "user"),
    "graph.act": ({ id, body }) => tasks.act(id, body.action, "user"),
    "graph.taskAct": ({ id, task, body }) => tasks.taskAct(id, task, body.action, "user"),
    "graph.changes": ({ id }) => tasks.changes(id),
    "graph.events": ({ id }) => tasks.events(id),
    "doc.list": () => docs.list(),
    "doc.create": ({ body }) => docs.create(body.title),
    "doc.import": ({ body }) => docs.importMarkdown(body.title, body.markdown, docOwner),
    "doc.get": ({ id }) => docs.get(id),
    "doc.submit": ({ id, body }) => docs.submit(id, docOwner, body),
    "doc.markdown": ({ id }) => Effect.map(docs.markdown(id), (markdown) => ({ markdown })),
    "doc.demo": ({ id }) => docs.demo(id, agents.agents()),
  };
  return done;
});
