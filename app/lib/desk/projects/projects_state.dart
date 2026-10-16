// The work directory's projects as the page last loaded them, and each project's latest survey (what it is written in,
// a year of its commits), as packages/core codebase.ts keeps them. The last answer stays on show while a new one is
// asked; a refusal is kept with its reason.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../shared/state.dart';

/// Something asked of the server: under way, in, or refused with why (core Asked).
sealed class Asked<A> {
  const Asked();
}

final class Asking<A> extends Asked<A> {
  const Asking();
}

final class Done<A> extends Asked<A> {
  const Done(this.value);
  final A value;
}

final class Failed<A> extends Asked<A> {
  const Failed(this.reason);
  final String reason;
}

class Survey {
  const Survey({this.languages, this.activity});
  final Asked<ProjectLanguages>? languages;
  final Asked<ProjectActivity>? activity;
}

class ProjectsState {
  const ProjectsState({this.list, this.surveys = const {}});

  /// null until loaded.
  final List<ProjectSummary>? list;

  /// By project name.
  final Map<String, Survey> surveys;
}

final projectsProvider = NotifierProvider<ProjectsNotifier, ProjectsState>(ProjectsNotifier.new);

class ProjectsNotifier extends Notifier<ProjectsState> {
  bool _loading = false;

  @override
  ProjectsState build() => const ProjectsState();

  VibeValleyApi get _api => ref.read(deskApiProvider);

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    try {
      final list = await _api.farm.projects();
      if (ref.mounted) state = ProjectsState(list: list, surveys: state.surveys);
    } finally {
      _loading = false;
    }
  }

  void _put(String project, Survey Function(Survey s) change) {
    final all = {...state.surveys};
    all[project] = change(all[project] ?? const Survey());
    state = ProjectsState(list: state.list, surveys: all);
  }

  /// Counts what a project is written in and reads a year of its commits, both at once.
  Future<void> survey(String project) => Future.wait([
    _ask<ProjectLanguages>(project, (s) => s.languages, (s, a) => Survey(languages: a, activity: s.activity), () => _api.farm.projectLanguages(id: project)),
    _ask<ProjectActivity>(project, (s) => s.activity, (s, a) => Survey(languages: s.languages, activity: a), () => _api.farm.projectActivity(id: project)),
  ]);

  Future<void> _ask<A>(String project, Asked<A>? Function(Survey) get, Survey Function(Survey, Asked<A>) set, Future<A> Function() request) async {
    if (get(state.surveys[project] ?? const Survey()) is! Done<A>) _put(project, (s) => set(s, Asking<A>()));
    Asked<A> answer;
    try {
      answer = Done(await request());
    } catch (e) {
      answer = Failed('$e');
    }
    if (ref.mounted) _put(project, (s) => set(s, answer));
  }

  /// Adds a project, then refreshes the list; throws why not.
  Future<ProjectSummary> create(NewProject req) async {
    final project = await _api.farm.createProject(body: req);
    await load();
    return project;
  }
}
