// Each handler only forwards to the service that owns the rule.

import { gatewayWording } from "./words.ts";
import { docOwner, type IssueUpdate } from "@vibevalley/protocol";
import type { Handlers } from "@vibevalley/protocol/api";
import { Agents } from "./agent/agent.ts";
import { missing, lookIn, reasonOf, refused } from "./errors.ts";
import { Projects } from "./project/project.ts";
import { Effect, Option } from "effect";
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
import { owner } from "./base/actor.ts";

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
  const edited = (ref: string, edit: IssueUpdate | undefined) => Effect.tap(issues.idOf(ref), (id) => (edit ? issues.edit(id, edit, owner) : Effect.void));
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
    "lan.previewStopPairing": () => Effect.sync(lan.previewStopPairing),
    "lan.answerPairing": ({ body }) => lan.answer(body.allow),
    "lan.deleteDevice": ({ id }) => lan.forget(id),
    "lan.previewDeleteDevice": ({ id }) => lan.previewForget(id),
    "lan.pair": ({ body }) => lan.pair(body.code, body.name),
    // Only the lan listener says a device, by a header it never takes from the device.
    "lan.me": () =>
      Effect.flatMap(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
        lan.me(Option.getOrUndefined(Option.map(request, (r) => r.headers[deviceHeader]))),
      ),
    "game.chooseTitle": ({ body }) => game.chooseTitle(body.achievement, body.tier),
    "github.refresh": () => Effect.flatMap(projects.refreshGitHub(), (status) => Effect.as(issues.refreshPullRequests, status)),
    "orchestrator.markWrong": ({ body }) => orchestrator.markWrong(body.on, body.want),
    "channel.say": ({ body }) =>
      Effect.andThen(
        Effect.sync(() => body.station !== undefined && game.want(body.station)),
        orchestrator.say(
          body.text,
          { ...(body.agent ? { agent: body.agent } : {}), ...(body.project ? { project: body.project } : {}) },
          body.channel,
          body.sendKey ?? "",
        ),
      ),
    "setting.load": () => Effect.sync(setting.status),
    "setting.check": ({ body }) => Effect.sync(() => setting.check(body)),
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
        Effect.flatMap((l) => (l ? Effect.succeed(l) : Effect.fail(missing(gatewayWording().projectRef(id), [lookIn.project])))),
      ),
    "project.activity": ({ id }) =>
      Effect.flatMap(projects.activity(id), (a) => (a ? Effect.succeed(a) : Effect.fail(missing(gatewayWording().projectRef(id), [lookIn.project])))),
    "agent.list": () => Effect.sync(agents.all),
    "agent.create": ({ body }) => agents.createAgent(body),
    "agent.save": ({ id, body }) => (body.id !== id ? Effect.fail(refused(gatewayWording().agentMismatch(id, body.id))) : agents.saveAgent(body)),
    "agent.delete": ({ id }) => agents.deleteAgent(id),
    "agent.previewDelete": ({ id }) => agents.previewDeleteAgent(id),
    "skill.list": () => Effect.sync(agents.skills),
    "skill.create": ({ body }) => agents.createSkill(body),
    "skill.save": ({ id, body }) => (body.id !== id ? Effect.fail(refused(gatewayWording().skillMismatch(id, body.id))) : agents.saveSkill(body)),
    "skill.delete": ({ id }) => agents.deleteSkill(id),
    "skill.previewDelete": ({ id }) => agents.previewDeleteSkill(id),
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, project, text }) => memory.recallOf(agent, project ?? "", text ?? ""),
    "memory.create": ({ agent, body }) => memory.remember({ agent, text: body.text, project: body.project ?? "", by: owner }),
    "memory.delete": ({ agent, memory: id }) => memory.forgetOf(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForgetOf(agent, id),
    "orchestrator.listArchive": ({ q }) => Effect.sync(() => memory.archive(q ?? "")),
    "orchestrator.getArchive": ({ name }) =>
      Effect.suspend(() => {
        const text = memory.archiveFile(name);
        return text !== undefined ? Effect.succeed(text) : Effect.fail(missing(gatewayWording().archiveRef(name), [lookIn.archive]));
      }),
    "runtime.list": () => Effect.sync(runtimes.list),
    "runtime.refresh": ({ id }) =>
      Effect.flatMap(runtimes.refresh(id), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id, [lookIn.runtime])))),
    "runtime.update": ({ id, body }) =>
      Effect.flatMap(runtimes.update(id, body), (info) => (info ? Effect.succeed(info) : Effect.fail(missing("runtime " + id, [lookIn.runtime])))),
    "agent.check": ({ body }) => Effect.forEach(body.agents, (agent) => Effect.map(runtimes.check(agent), (problems) => ({ id: agent.id, problems }))),
    "session.stop": ({ id }) => (sessions.find(id) ? Effect.asVoid(sessions.stop(id)) : Effect.fail(missing(gatewayWording().helperRef(id), [lookIn.session]))),
    "session.list": ({ agent }) => sessions.list(agent ?? ""),
    "session.get": ({ id }) =>
      Effect.flatMap(sessions.get(id), (s) => (s ? Effect.succeed(s) : Effect.fail(missing(gatewayWording().helperRef(id), [lookIn.session])))),
    "session.events": ({ id, run }) => Effect.sync(() => sessions.events(id, run ?? "") ?? []),
    "channel.create": ({ body }) => Effect.map(channels.openChannel(body.name, body.description ?? "", body.project ?? ""), (c) => c.id),
    "channel.update": ({ id, body }) => channels.updateChannel(id, body.description, body.project),
    "channel.history": ({ id, before, limit }) => channels.history(id, before, limit),
    "channel.markRead": ({ id, body }) => channels.markRead(id, body.number).pipe(Effect.mapError((e) => missing(reasonOf(e), [lookIn.channel]))),
    "recurrence.create": ({ body }) => recurrences.add(body, owner),
    "recurrence.list": () => Effect.sync(recurrences.list),
    "recurrence.update": ({ id, body }) => (body.enabled === undefined ? Effect.void : Effect.asVoid(recurrences.setEnabled(id, body.enabled))),
    "recurrence.delete": ({ id }) => Effect.asVoid(recurrences.remove(id)),
    "recurrence.previewDelete": ({ id }) => recurrences.previewRemove(id),
    "issue.list": () => issues.list(),
    "issue.history": () => issues.history(),
    "issue.get": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.get(id)),
    "issue.runs": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => Effect.andThen(issues.get(id), sessions.runs(id))),
    "issue.timeline": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.timeline(id)),
    "issue.create": ({ body }) => issues.add(body),
    "issue.update": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.edit(id, body, owner)),
    "issue.move": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.move(id, body.before ?? "")),
    "issue.delete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.remove(id)),
    "issue.previewDelete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.previewRemove(id)),
    "issue.act": ({ id, body }) => issues.act(id, body, channels.general(), owner),
    "issue.previewAct": ({ id, body }) => issues.previewAct(id, body),
    "issue.previewStatus": ({ id: ref, body }) =>
      Effect.flatMap(issues.idOf(ref), (id) =>
        issues.previewStatus(
          id,
          body.status,
          body.text ?? "",
          { ...(body.agent ? { agent: body.agent } : {}), ...(body.keepBranch ? { keepBranch: true } : {}) },
          body.edit,
        ),
      ),
    "issue.refine": ({ id: ref, body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.refine(id, body.text ?? "", channels.general())),
    "issue.dispatch": ({ id: ref, body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.dispatchQueued(id)),
    "issue.status": ({ id: ref, body }) =>
      Effect.flatMap(edited(ref, body.edit), (id) =>
        issues.setStatus(id, body.status, body.text ?? "", channels.general(), owner, {
          ...(body.agent ? { agent: body.agent } : {}),
          ...(body.keepBranch ? { keepBranch: true } : {}),
        }),
      ),
    "issue.comment": ({ id: ref, body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.comment(id, body.text, body.sendKey ?? "")),
    "issue.changes": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.changes(id, owner)),
    "project.templates": ({ id }) => issues.templates(id),
    "graph.split": ({ body }) => tasks.split(body.goal, body.project, body.agent ?? "", owner),
    "graph.updateTask": ({ id, task, body }) => tasks.editTask(id, task, body, owner),
    "graph.deleteTask": ({ id, task }) => tasks.removeTask(id, task, owner),
    "graph.previewDeleteTask": ({ id, task }) => tasks.previewRemoveTask(id, task),
    "graph.act": ({ id, body }) => tasks.act(id, body.action, owner),
    "graph.taskAct": ({ id, task, body }) => tasks.taskAct(id, task, body.action, owner),
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
