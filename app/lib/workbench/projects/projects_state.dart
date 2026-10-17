// The last answer stays on show while a new one is asked; a refusal is kept with its reason.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../data/providers.dart';

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

final projectSurveyProvider = NotifierProvider.family<ProjectSurvey, Survey, String>(ProjectSurvey.new);

class ProjectSurvey extends Notifier<Survey> {
  ProjectSurvey(this.project);
  final String project;
  Future<void>? _refreshing;

  @override
  Survey build() {
    unawaited(Future.microtask(refresh));
    return const Survey();
  }

  Future<void> refresh() => _refreshing ??= _read().whenComplete(() => _refreshing = null);

  Future<void> _read() async {
    if (!ref.mounted) return;
    final api = ref.read(apiProvider).project;
    await Future.wait([
      _ask<ProjectLanguages>((s) => s.languages, (s, a) => Survey(languages: a, activity: s.activity), () => api.languages(id: project)),
      _ask<ProjectActivity>((s) => s.activity, (s, a) => Survey(languages: s.languages, activity: a), () => api.activity(id: project)),
    ]);
  }

  Future<void> _ask<A>(Asked<A>? Function(Survey) get, Survey Function(Survey, Asked<A>) set, Future<A> Function() request) async {
    if (get(state) is! Done<A>) state = set(state, Asking<A>());
    Asked<A> answer;
    try {
      answer = Done(await request());
    } catch (e) {
      answer = Failed('$e');
    }
    if (ref.mounted) state = set(state, answer);
  }
}
