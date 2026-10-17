// What the client reads from the server besides the state stream: the profiles, the runtimes, the projects, the workers'
// activities, the memories. Every edit goes through the server and then reloads the part it changed; nothing here folds facts.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';
import '../gen/vibevalley.dart';
import '../rules/playbook.dart';

String reasonOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

class DeskConfig {
  const DeskConfig({this.loaded = false, this.runtimes = const [], this.agents = const [], this.skills = const []});
  final bool loaded;
  final List<RuntimeInfo> runtimes;
  final List<Agent> agents;
  final List<Skill> skills;

  DeskConfig copyWith({bool? loaded, List<RuntimeInfo>? runtimes, List<Agent>? agents, List<Skill>? skills}) =>
      DeskConfig(loaded: loaded ?? this.loaded, runtimes: runtimes ?? this.runtimes, agents: agents ?? this.agents, skills: skills ?? this.skills);

  Agent? agent(String? id) => id == null ? null : agents.where((a) => a.id == id).firstOrNull;
  RuntimeInfo? runtime(String id) => runtimes.where((r) => r.id == id).firstOrNull;
}

final deskConfigProvider = NotifierProvider<DeskConfigNotifier, DeskConfig>(DeskConfigNotifier.new);

class DeskConfigNotifier extends Notifier<DeskConfig> {
  @override
  DeskConfig build() {
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case SideEventRuntime(:final info) when state.runtimes.any((r) => r.id == info.id)) {
        state = state.copyWith(runtimes: [for (final r in state.runtimes) r.id == info.id ? info : r]);
      }
    });
    unawaited(Future.microtask(refresh));
    return const DeskConfig();
  }

  VibeValleyApi get _api => ref.read(apiProvider);

  /// Runtimes take a while right after the server starts (it probes each one): the agents and skills need not wait for them.
  Future<void> refresh() async {
    await Future.wait([
      () async {
        final (agents, skills) = (await _api.agent.list(), await _api.skill.list());
        state = state.copyWith(agents: agents, skills: skills);
      }(),
      () async {
        final runtimes = await _api.runtime.list();
        state = state.copyWith(runtimes: runtimes);
      }(),
    ]).catchError((Object _) => const <Null>[]);
    state = state.copyWith(loaded: true);
  }

  Future<void> saveAgent(Agent agent) async {
    await _api.agent.save(id: agent.id, body: agent);
    state = state.copyWith(agents: await _api.agent.list());
  }

  Future<void> deleteAgent(String id) async {
    await _api.agent.delete(id: id);
    state = state.copyWith(agents: await _api.agent.list());
  }

  Future<void> saveSkill(Skill skill) async {
    await _api.skill.save(id: skill.id, body: skill);
    state = state.copyWith(skills: await _api.skill.list());
  }

  /// Deleting a skill also takes it off the agents that carried it, so both lists come back.
  Future<void> deleteSkill(String id) async {
    await _api.skill.delete(id: id);
    final (skills, agents) = (await _api.skill.list(), await _api.agent.list());
    state = state.copyWith(skills: skills, agents: agents);
  }
}

class InstalledSkill {
  const InstalledSkill(this.name, this.description, this.runtimes);
  final String name;
  final String? description;

  /// A path, or a settings scope.
  final List<({String runtime, String? source})> runtimes;
}

List<InstalledSkill> installedSkills(List<RuntimeInfo> runtimes) {
  final byName = <String, ({List<String?> description, List<({String runtime, String? source})> runtimes})>{};
  for (final r in runtimes) {
    for (final s in r.skills ?? const <InventoryEntry>[]) {
      final got = byName.putIfAbsent(s.name, () => (description: [null], runtimes: []));
      if ((got.description.first ?? '').isEmpty && (s.description ?? '').isNotEmpty) got.description.first = s.description;
      got.runtimes.add((runtime: r.id, source: (s.source ?? '').isEmpty ? null : s.source));
    }
  }
  return [for (final MapEntry(:key, :value) in byName.entries) InstalledSkill(key, value.description.first, value.runtimes)]
    ..sort((a, b) => a.name.compareTo(b.name));
}

final projectNamesProvider = FutureProvider<List<String>>((ref) async {
  final list = await ref.watch(apiProvider).project.list();
  list.sort((a, b) {
    final by = (b.last ?? 0).compareTo(a.last ?? 0);
    return by != 0 ? by : a.name.compareTo(b.name);
  });
  return [for (final p in list) p.name];
});

const stepLimit = 240;

/// By number, in order.
List<Activity> mergeSteps(List<Activity> steps, List<Activity> incoming) {
  final byN = {for (final s in steps) s.n: s};
  for (final s in incoming) {
    byN[s.n] = s;
  }
  final all = byN.values.toList()..sort((a, b) => a.n.compareTo(b.n));
  return all.length > stepLimit ? all.sublist(all.length - stepLimit) : all;
}

final workStepsProvider = NotifierProvider<ActivitiesNotifier, Map<String, List<Activity>>>(ActivitiesNotifier.new);

class ActivitiesNotifier extends Notifier<Map<String, List<Activity>>> {
  @override
  Map<String, List<Activity>> build() {
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case SideEventActivity(:final id, :final activity)) {
        state = {
          ...state,
          id: mergeSteps(state[id] ?? const [], [activity]),
        };
      }
    });
    return const {};
  }

  /// Null when there is none. Steps that came as events meanwhile stay: they are newer.
  Future<TrajectoryHead?> load(String id) async {
    final Trajectory found;
    try {
      found = await ref.read(apiProvider).trajectory.get(id: id);
    } on VibeValleyApiError catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
    final top = found.activities.isEmpty ? -1 : found.activities.last.n;
    state = {
      ...state,
      id: mergeSteps(found.activities, [
        for (final s in state[id] ?? const <Activity>[])
          if (s.n > top) s,
      ]),
    };
    return found.head;
  }
}

final memoriesProvider = NotifierProvider<MemoriesNotifier, Map<String, List<Memory>>>(MemoriesNotifier.new);

class MemoriesNotifier extends Notifier<Map<String, List<Memory>>> {
  @override
  Map<String, List<Memory>> build() => const {};

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> load(String agent) async {
    final list = await _api.agent.memories(id: agent);
    state = {...state, agent: list};
  }

  Future<Answer> write(String agent, String text, String? project) async {
    try {
      final memory = await _api.agent.remember(
        id: agent,
        body: MemoryRequest(text: text, project: project),
      );
      state = {
        ...state,
        agent: [memory, ...?state[agent]],
      };
      return (ok: true, text: '记下了');
    } on Object catch (e) {
      return (ok: false, text: reasonOf(e));
    }
  }

  Future<void> forget(String agent, String id) async {
    state = {
      ...state,
      agent: [
        for (final m in state[agent] ?? const <Memory>[])
          if (m.id != id) m,
      ],
    };
    await _api.agent.forget(id: agent, memory: id);
  }
}

final managerMemoryProvider = NotifierProvider<ManagerMemoryNotifier, ManagerMemory?>(ManagerMemoryNotifier.new);

class ManagerMemoryNotifier extends Notifier<ManagerMemory?> {
  @override
  ManagerMemory? build() => null;

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> load() async => state = await _api.manager.memories();

  Future<Answer> write(String text) async {
    try {
      await _api.manager.remember(body: MemoryRequest(text: text));
      await load();
      return (ok: true, text: '记下了');
    } on Object catch (e) {
      return (ok: false, text: reasonOf(e));
    }
  }

  Future<void> forget(String id) async {
    final m = state;
    if (m != null) {
      state = ManagerMemory(
        runtime: m.runtime,
        file: m.file,
        memories: [
          for (final x in m.memories)
            if (x.id != id) x,
        ],
        carried: m.carried,
      );
    }
    await _api.manager.forget(memory: id);
    await load();
  }
}

/// The runtimes as deskConfigProvider has them (pushed by the server as they change); loading until it has read them.
final runtimesProvider = Provider<AsyncValue<List<RuntimeInfo>>>((ref) {
  final config = ref.watch(deskConfigProvider);
  return config.loaded ? AsyncData(config.runtimes) : const AsyncLoading();
});

/// The profiles by id, as deskConfigProvider has them: an edit anywhere shows everywhere.
final agentsProvider = Provider<AsyncValue<Map<String, Agent>>>((ref) {
  final config = ref.watch(deskConfigProvider);
  return config.loaded ? AsyncData({for (final a in config.agents) a.id: a}) : const AsyncLoading();
});

/// Each profile's issues as the server would dispatch it now (agent.check), by id; asked again when the profiles change or
/// the page comes back.
final agentIssuesProvider = FutureProvider.autoDispose.family<Map<String, List<AgentIssue>>, String>((ref, agentsJson) async {
  final agents = [for (final j in jsonDecode(agentsJson) as List) Agent.fromJson(j as Map<String, dynamic>)];
  final checks = await ref.watch(apiProvider).agent.check(body: AgentCheckRequest(agents: agents));
  return {for (final c in checks) c.id: c.issues};
});

/// Empty until the server answers.
Map<String, List<AgentIssue>> watchAgentIssues(WidgetRef ref, List<Agent> agents) =>
    ref.watch(agentIssuesProvider(jsonEncode([for (final a in agents) a.toJson()]))).value ?? const {};

/// What a worker of the agent would recall starting a run in the project, told the text (agent.recall); nothing is counted.
final recallPreviewProvider = FutureProvider.autoDispose.family<RecallPreview, ({String agent, String project, String text})>((ref, q) {
  // Again when the agent's memories change.
  ref.watch(memoriesProvider.select((all) => all[q.agent]));
  return ref.watch(apiProvider).agent.recall(id: q.agent, project: q.project, text: q.text);
});

/// What saving these settings would be refused for (setting.check), null when nothing; keyed by the update as JSON.
final settingsProblemProvider = FutureProvider.autoDispose.family<String?, String>((ref, updateJson) async {
  final update = SettingsUpdate.fromJson(jsonDecode(updateJson) as Map<String, dynamic>);
  final check = await ref.watch(apiProvider).setting.check(body: update);
  return check.problem;
});

/// Null until the server answers, and when nothing is wrong.
String? watchSettingsProblem(WidgetRef ref, SettingsUpdate update) => ref.watch(settingsProblemProvider(jsonEncode(update.toJson()))).value;

/// The issue a worker works: the server gives every worker one, and an issue's lifecycle (comment, changes, merge,
/// cancel) is asked by it.
extension WorkerIssue on Worker {
  String get issueId => issue ?? (throw StateError('worker $id has no issue'));
}
