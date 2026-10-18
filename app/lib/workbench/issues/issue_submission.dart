import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

import '../../gen/vibevalley.dart';

const _pickKey = 'vibevalley.board.pick';

class IssueSubmission {
  IssueSubmission(this.api, {Issue? initial}) : _saved = initial;
  final IssueApi api;
  Issue? _saved;

  /// A successful save remains available even if dispatch subsequently fails.
  Issue? get saved => _saved;

  static Future<({String agent, String project})> remembered() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getStringList(_pickKey);
      if (raw != null && raw.length == 2) return (agent: raw[0], project: raw[1]);
    } on Object {
      // Preferences are optional; a server mutation must not depend on them.
    }
    return (agent: '', project: '');
  }

  Future<Issue> quick(String title, {String agent = '', String project = ''}) async {
    final last = await remembered();
    final who = agent.isEmpty ? last.agent : agent;
    final where = project.isEmpty ? last.project : project;
    return save(IssueRequest(title: title, assignee: who.isEmpty ? null : who, project: where.isEmpty ? null : where));
  }

  Future<Issue> save(IssueRequest draft) async {
    final previous = _saved;
    final issue = previous == null
        ? await api.create(body: draft)
        : await api.update(
            id: previous.id,
            body: IssueUpdate(
              title: draft.title,
              description: draft.description ?? '',
              project: draft.project ?? '',
              assignee: draft.assignee ?? '',
              priority: draft.priority,
              acceptance: draft.acceptance,
            ),
          );
    _saved = issue;
    unawaited(_remember(draft));
    return issue;
  }

  Future<void> _remember(IssueRequest draft) async {
    if ((draft.assignee ?? '').isNotEmpty || (draft.project ?? '').isNotEmpty) {
      try {
        await (await SharedPreferences.getInstance()).setStringList(_pickKey, [draft.assignee ?? '', draft.project ?? '']);
      } on Object {
        // The issue has already been saved; preference storage is best-effort.
      }
    }
  }

  Future<Issue> start(IssueRequest draft) async {
    final issue = await save(draft);
    return api.status(
      id: issue.id,
      body: const IssueStatusRequest(status: IssueStatus.todo),
    );
  }
}
