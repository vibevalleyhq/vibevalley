// What the client reads from the server besides the state stream: the profiles, the runtimes, the projects, the sessions'
// activities, the memories. Every edit goes through the server and then reloads the part it changed; nothing here folds facts.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';
import '../gen/vibevalley.dart';
import '../rules/playbook.dart';

String reasonOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

class WorkbenchConfig {
  const WorkbenchConfig({this.loaded = false, this.error, this.runtimes = const [], this.agents = const [], this.manager, this.skills = const []});
  final bool loaded;
  final String? error;
  final List<RuntimeInfo> runtimes;
  // The profiles work is sent to; the manager's is apart.
  final List<Agent> agents;
  final Agent? manager;
  final List<Skill> skills;

  WorkbenchConfig copyWith({bool? loaded, String? error, List<RuntimeInfo>? runtimes, List<Agent>? agents, Agent? manager, List<Skill>? skills}) =>
      WorkbenchConfig(
        loaded: loaded ?? this.loaded,
        error: error,
        runtimes: runtimes ?? this.runtimes,
        agents: agents ?? this.agents,
        manager: manager ?? this.manager,
        skills: skills ?? this.skills,
      );

  Agent? agent(String? id) => id == null ? null : agents.where((a) => a.id == id).firstOrNull;
  RuntimeInfo? runtime(String id) => runtimes.where((r) => r.id == id).firstOrNull;
}

final workbenchConfigProvider = NotifierProvider<WorkbenchConfigNotifier, WorkbenchConfig>(WorkbenchConfigNotifier.new);

class WorkbenchConfigNotifier extends Notifier<WorkbenchConfig> {
  var _generation = 0;
  var _runtimeRevision = 0;
  final _runtimeChanges = <String, int>{};

  @override
  WorkbenchConfig build() {
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case LiveEventRuntime(:final info)) {
        _runtimeChanges[info.id] = ++_runtimeRevision;
        state = state.copyWith(
          runtimes: [for (final r in state.runtimes) r.id == info.id ? info : r, if (!state.runtimes.any((r) => r.id == info.id)) info],
          error: state.error,
        );
      }
    });
    unawaited(Future.microtask(refresh));
    return const WorkbenchConfig();
  }

  VibeValleyApi get _api => ref.read(apiProvider);

  /// A newer refresh owns the result; runtime pushes received during a read win over its snapshot.
  Future<void> refresh() async {
    if (!ref.mounted) return;
    final generation = ++_generation;
    final runtimeRevision = _runtimeRevision;
    final api = _api;
    try {
      await Future.wait([
        () async {
          final (agents, skills) = (await api.agent.list(), await api.skill.list());
          if (ref.mounted && generation == _generation) state = _withProfiles(agents).copyWith(skills: skills);
        }(),
        () async {
          final runtimes = await api.runtime.list();
          if (!ref.mounted || generation != _generation) return;
          final pushed = {
            for (final r in state.runtimes)
              if ((_runtimeChanges[r.id] ?? 0) > runtimeRevision) r.id: r,
          };
          state = state.copyWith(runtimes: [for (final r in runtimes) pushed.remove(r.id) ?? r, ...pushed.values]);
        }(),
      ]);
      if (ref.mounted && generation == _generation) state = state.copyWith(loaded: true);
    } on Object catch (e) {
      if (ref.mounted && generation == _generation) state = state.copyWith(error: reasonOf(e));
    }
  }

  /// agent.list has the manager's profile too: it is kept apart, so every list of profiles to send work to has none of it.
  WorkbenchConfig _withProfiles(List<Agent> all) => state.copyWith(
    agents: [
      for (final a in all)
        if (a.id != managerAgent) a,
    ],
    manager: all.where((a) => a.id == managerAgent).firstOrNull,
  );

  Future<void> saveAgent(Agent agent) async {
    await _api.agent.save(id: agent.id, body: agent);
    await refresh();
  }

  Future<void> deleteAgent(String id) async {
    await _api.agent.delete(id: id);
    await refresh();
  }

  Future<void> saveSkill(Skill skill) async {
    await _api.skill.save(id: skill.id, body: skill);
    await refresh();
  }

  /// Deleting a skill also takes it off the agents that carried it, so both lists come back.
  Future<void> deleteSkill(String id) async {
    await _api.skill.delete(id: id);
    await refresh();
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

final projectCatalogProvider = AsyncNotifierProvider.autoDispose<ProjectCatalog, List<ProjectSummary>>(ProjectCatalog.new);

class ProjectCatalog extends AsyncNotifier<List<ProjectSummary>> {
  @override
  Future<List<ProjectSummary>> build() async {
    final list = await ref.watch(apiProvider).project.list();
    list.sort((a, b) {
      final by = (b.last ?? 0).compareTo(a.last ?? 0);
      return by != 0 ? by : a.name.compareTo(b.name);
    });
    return list;
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<ProjectSummary> create(NewProject request) async {
    final project = await ref.read(apiProvider).project.create(body: request);
    await refresh();
    return project;
  }
}

final projectNamesProvider = FutureProvider.autoDispose<List<String>>((ref) async => [for (final p in await ref.watch(projectCatalogProvider.future)) p.name]);

const stepLimit = 240;

/// By number, in order.
List<SessionEvent> mergeSteps(List<SessionEvent> steps, List<SessionEvent> incoming) {
  final byN = {for (final s in steps) s.seq: s};
  for (final s in incoming) {
    byN[s.seq] = s;
  }
  final all = byN.values.toList()..sort((a, b) => a.seq.compareTo(b.seq));
  return all.length > stepLimit ? all.sublist(all.length - stepLimit) : all;
}

final playbookChangesProvider = FutureProvider.autoDispose.family<Changes, String>((ref, id) => ref.watch(apiProvider).playbook.changes(id: id));

final issueChangesProvider = FutureProvider.autoDispose.family<Changes, String>((ref, id) => ref.watch(apiProvider).issue.changes(id: id));

final sessionEventsProvider = AsyncNotifierProvider.autoDispose.family<SessionEvents, List<SessionEvent>, String>(SessionEvents.new);

class SessionEvents extends AsyncNotifier<List<SessionEvent>> {
  SessionEvents(this.id);
  final String id;

  @override
  Future<List<SessionEvent>> build() async {
    final arrived = <SessionEvent>[];
    var loaded = false;
    ref.listen(sideEventsProvider, (_, next) {
      if (next.value case LiveEventSession(id: final session, :final activity) when session == id) {
        if (loaded) {
          state = AsyncData(mergeSteps(state.value ?? const [], [activity]));
        } else {
          arrived.add(activity);
        }
      }
    });
    try {
      final events = await ref.watch(apiProvider).session.events(id: id);
      return mergeSteps(events, arrived);
    } finally {
      loaded = true;
    }
  }
}

final memoryProvider = AsyncNotifierProvider.autoDispose.family<MemoriesNotifier, MemoryList, String>(MemoriesNotifier.new);

class MemoriesNotifier extends AsyncNotifier<MemoryList> {
  MemoriesNotifier(this.agent);
  final String agent;

  @override
  Future<MemoryList> build() => ref.watch(apiProvider).memory.list(agent: agent);

  Future<void> reload() async {
    ref.invalidateSelf();
    await future;
  }

  Future<Answer> write(String text, [String? project]) async {
    try {
      await ref
          .read(apiProvider)
          .memory
          .create(
            agent: agent,
            body: MemoryRequest(text: text, project: project),
          );
      await reload();
      return (ok: true, text: '记下了');
    } on Object catch (e) {
      return (ok: false, text: reasonOf(e));
    }
  }

  Future<void> forget(String id) async {
    await ref.read(apiProvider).memory.delete(agent: agent, memory: id);
    await reload();
  }
}

/// The runtimes as workbenchConfigProvider has them (pushed by the server as they change); loading until it has read them.
final runtimesProvider = Provider<AsyncValue<List<RuntimeInfo>>>((ref) {
  final config = ref.watch(workbenchConfigProvider);
  if (config.error != null) return AsyncError(config.error!, StackTrace.current);
  return config.loaded ? AsyncData(config.runtimes) : const AsyncLoading();
});

/// The profiles by id, as workbenchConfigProvider has them: an edit anywhere shows everywhere.
final agentsProvider = Provider<AsyncValue<Map<String, Agent>>>((ref) {
  final config = ref.watch(workbenchConfigProvider);
  if (config.error != null) return AsyncError(config.error!, StackTrace.current);
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

/// What a session of the agent would recall starting a run in the project, told the text (agent.recall); nothing is counted.
final recallPreviewProvider = FutureProvider.autoDispose.family<RecallPreview, ({String agent, String project, String text})>((ref, q) {
  // Again when the agent's memories change.
  ref.watch(memoryProvider(q.agent));
  return ref.watch(apiProvider).memory.recall(agent: q.agent, project: q.project, text: q.text);
});

/// What saving these settings would be refused for (setting.check), null when nothing; keyed by the update as JSON.
final settingsProblemProvider = FutureProvider.autoDispose.family<String?, String>((ref, updateJson) async {
  final update = SettingsUpdate.fromJson(jsonDecode(updateJson) as Map<String, dynamic>);
  final check = await ref.watch(apiProvider).setting.check(body: update);
  return check.problem;
});

/// Null until the server answers, and when nothing is wrong.
String? watchSettingsProblem(WidgetRef ref, SettingsUpdate update) => ref.watch(settingsProblemProvider(jsonEncode(update.toJson()))).value;

/// The issue a session works: the server gives every session one, and an issue's lifecycle (comment, changes, merge,
/// cancel) is asked by it.
extension SessionEnd on Session {
  /// When it ended; null for one on the farm.
  double? get endedAt => switch (phase) {
    PhaseClosed(:final at) => at,
    _ => null,
  };
}

extension SessionIssue on Session {
  String get issueId => issue ?? (throw StateError('session $id has no issue'));
}
