// What the desk pages load from the server, as Riverpod state (packages/core config.ts, memory.ts, session.ts
// loadTrajectory, site.ts workSteps, web/src/farm/projects.ts). Every edit goes through the server and then reloads
// the part it changed, as on the web page; nothing here folds facts.
//   deskApiProvider        the server's API; tests override it with VibeValleyApi(base, MockClient(...))
//   deskConfigProvider     runtimes, agents and the skill library (config.ts Config), with save and delete
//   installedSkills        the skills the runtimes report, by name (config.ts installedSkills)
//   projectNamesProvider   the work directory's projects, the newest-worked first (useProjectNames)
//   workStepsProvider      trajectories' steps by id, kept up by the server's step events (workSteps, loadTrajectory)
//   memoriesProvider       each helper agent's memories (memories, loadMemories, writeMemory, forgetMemory)
//   managerMemoryProvider  the manager's memory (managerMemory and its commands)

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/playbook.dart';

final deskApiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

String reasonOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

// ── Config ───────────────────────────────────────────────────────────────────

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
    // A runtime changed on the server (its usage, mostly); one not loaded yet comes with the config.
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case SiteEventRuntime(:final info) when state.runtimes.any((r) => r.id == info.id)) {
        state = state.copyWith(runtimes: [for (final r in state.runtimes) r.id == info.id ? info : r]);
      }
    });
    unawaited(Future.microtask(refresh));
    return const DeskConfig();
  }

  VibeValleyApi get _api => ref.read(deskApiProvider);

  /// Loads everything again. Runtimes take a while right after the server starts (it probes each one): the agents and
  /// skills need not wait for them.
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

/// A skill installed on this machine, as the runtimes report it: one entry per name, with every runtime that has it.
class InstalledSkill {
  const InstalledSkill(this.name, this.description, this.runtimes);
  final String name;
  final String? description;

  /// The runtimes that load it, and where each found it (a path, or a settings scope).
  final List<({String runtime, String? source})> runtimes;
}

/// The skills the runtimes have installed, by name, A to Z.
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

// ── Projects ─────────────────────────────────────────────────────────────────

/// The work directory's projects for the forms that ask for one: their names, the newest-worked first.
final projectNamesProvider = FutureProvider<List<String>>((ref) async {
  final list = await ref.watch(deskApiProvider).farm.projects();
  list.sort((a, b) {
    final by = (b.last ?? 0).compareTo(a.last ?? 0);
    return by != 0 ? by : a.name.compareTo(b.name);
  });
  return [for (final p in list) p.name];
});

// ── Trajectories ─────────────────────────────────────────────────────────────

/// Steps kept per trajectory (core site.ts STEP_LIMIT).
const stepLimit = 240;

/// `steps` with `incoming` laid over them by number, in order.
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

  /// Loads a trajectory (a helper's, on the farm or gone, or the manager's): its steps, kept up by step events from
  /// then on; its head returned. Null when there is none. Steps that came as events meanwhile stay: they are newer.
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

// ── Memory ───────────────────────────────────────────────────────────────────

/// Each agent's memories as last loaded, newest first, by agent id.
final memoriesProvider = NotifierProvider<MemoriesNotifier, Map<String, List<Memory>>>(MemoriesNotifier.new);

class MemoriesNotifier extends Notifier<Map<String, List<Memory>>> {
  @override
  Map<String, List<Memory>> build() => const {};

  VibeValleyApi get _api => ref.read(deskApiProvider);

  Future<void> load(String agent) async {
    final list = await _api.farm.memories(id: agent);
    state = {...state, agent: list};
  }

  /// A note for an agent, written by the person: kept, or why not.
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

/// The manager's memory as last loaded; null until its page opens.
final managerMemoryProvider = NotifierProvider<ManagerMemoryNotifier, ManagerMemory?>(ManagerMemoryNotifier.new);

class ManagerMemoryNotifier extends Notifier<ManagerMemory?> {
  @override
  ManagerMemory? build() => null;

  VibeValleyApi get _api => ref.read(deskApiProvider);

  Future<void> load() async => state = await _api.farm.managerMemory();

  /// A note for the manager, written by the person: kept, or why not.
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
