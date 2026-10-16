// Every edit goes through the server and then reloads the part it changed; nothing here folds facts.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/playbook.dart';

final deskApiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

String reasonOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

class DeskConfig {
  const DeskConfig({this.loaded = false, this.runtimes = const [], this.agents = const [], this.skills = const []});
  final bool loaded;
  final List<RuntimeInfo> runtimes;
  final List<AgentProfile> agents;
  final List<Skill> skills;

  DeskConfig copyWith({bool? loaded, List<RuntimeInfo>? runtimes, List<AgentProfile>? agents, List<Skill>? skills}) =>
      DeskConfig(loaded: loaded ?? this.loaded, runtimes: runtimes ?? this.runtimes, agents: agents ?? this.agents, skills: skills ?? this.skills);

  AgentProfile? agent(String? id) => id == null ? null : agents.where((a) => a.id == id).firstOrNull;
  RuntimeInfo? runtime(String id) => runtimes.where((r) => r.id == id).firstOrNull;
}

final deskConfigProvider = NotifierProvider<DeskConfigNotifier, DeskConfig>(DeskConfigNotifier.new);

class DeskConfigNotifier extends Notifier<DeskConfig> {
  @override
  DeskConfig build() {
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case SiteEventRuntime(:final info) when state.runtimes.any((r) => r.id == info.id)) {
        state = state.copyWith(runtimes: [for (final r in state.runtimes) r.id == info.id ? info : r]);
      }
    });
    unawaited(Future.microtask(refresh));
    return const DeskConfig();
  }

  VibeValleyApi get _api => ref.read(deskApiProvider);

  /// Runtimes take a while right after the server starts (it probes each one): the agents and skills need not wait for them.
  Future<void> refresh() async {
    await Future.wait([
      () async {
        final (agents, skills) = (await _api.farm.agents(), await _api.farm.skills());
        state = state.copyWith(agents: agents, skills: skills);
      }(),
      () async {
        final runtimes = await _api.farm.runtimes();
        state = state.copyWith(runtimes: runtimes);
      }(),
    ]).catchError((Object _) => const <Null>[]);
    state = state.copyWith(loaded: true);
  }

  Future<void> saveAgent(AgentProfile agent) async {
    await _api.farm.saveAgent(id: agent.id, body: agent);
    state = state.copyWith(agents: await _api.farm.agents());
  }

  Future<void> deleteAgent(String id) async {
    await _api.farm.deleteAgent(id: id);
    state = state.copyWith(agents: await _api.farm.agents());
  }

  Future<void> saveSkill(Skill skill) async {
    await _api.farm.saveSkill(id: skill.id, body: skill);
    state = state.copyWith(skills: await _api.farm.skills());
  }

  /// Deleting a skill also takes it off the agents that carried it, so both lists come back.
  Future<void> deleteSkill(String id) async {
    await _api.farm.deleteSkill(id: id);
    final (skills, agents) = (await _api.farm.skills(), await _api.farm.agents());
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
  final list = await ref.watch(deskApiProvider).farm.projects();
  list.sort((a, b) {
    final by = (b.last ?? 0).compareTo(a.last ?? 0);
    return by != 0 ? by : a.name.compareTo(b.name);
  });
  return [for (final p in list) p.name];
});

const stepLimit = 240;

/// By number, in order.
List<WorkStep> mergeSteps(List<WorkStep> steps, List<WorkStep> incoming) {
  final byN = {for (final s in steps) s.n: s};
  for (final s in incoming) {
    byN[s.n] = s;
  }
  final all = byN.values.toList()..sort((a, b) => a.n.compareTo(b.n));
  return all.length > stepLimit ? all.sublist(all.length - stepLimit) : all;
}

final workStepsProvider = NotifierProvider<WorkStepsNotifier, Map<String, List<WorkStep>>>(WorkStepsNotifier.new);

class WorkStepsNotifier extends Notifier<Map<String, List<WorkStep>>> {
  @override
  Map<String, List<WorkStep>> build() {
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case SiteEventStep(:final id, :final step)) {
        state = {
          ...state,
          id: mergeSteps(state[id] ?? const [], [step]),
        };
      }
    });
    return const {};
  }

  /// Null when there is none. Steps that came as events meanwhile stay: they are newer.
  Future<TrajectoryHead?> load(String id) async {
    final Trajectory found;
    try {
      found = await ref.read(deskApiProvider).farm.trajectory(id: id);
    } on VibeValleyApiError catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
    final top = found.steps.isEmpty ? -1 : found.steps.last.n;
    state = {
      ...state,
      id: mergeSteps(found.steps, [
        for (final s in state[id] ?? const <WorkStep>[])
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

  VibeValleyApi get _api => ref.read(deskApiProvider);

  Future<void> load(String agent) async {
    final list = await _api.farm.memories(id: agent);
    state = {...state, agent: list};
  }

  Future<Answer> write(String agent, String text, String? project) async {
    try {
      final memory = await _api.farm.remember(
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
    await _api.farm.forget(id: agent, memory: id);
  }
}

final managerMemoryProvider = NotifierProvider<ManagerMemoryNotifier, ManagerMemory?>(ManagerMemoryNotifier.new);

class ManagerMemoryNotifier extends Notifier<ManagerMemory?> {
  @override
  ManagerMemory? build() => null;

  VibeValleyApi get _api => ref.read(deskApiProvider);

  Future<void> load() async => state = await _api.farm.managerMemory();

  Future<Answer> write(String text) async {
    try {
      await _api.farm.managerRemember(body: MemoryRequest(text: text));
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
    await _api.farm.managerForget(memory: id);
    await load();
  }
}
