import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

import '../../game/commands.dart' show writeIssue;
import '../../gen/vibevalley.dart';
import '../../ui/toasts.dart' show ToastType, toasts;

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

  /// The plus: made at once, with the helper and project last picked unless given; words start its draft. A draft the
  /// server refuses is said in a toast, and the issue is still there to open.
  Future<Issue> write(String text, {String agent = '', String project = ''}) async {
    final last = await remembered();
    final who = agent.isEmpty ? last.agent : agent;
    final where = project.isEmpty ? last.project : project;
    final got = await writeIssue(api, text: text, agent: who.isEmpty ? null : who, project: where.isEmpty ? null : where);
    if (got.refused.isNotEmpty) toasts.add(type: ToastType.info, title: '先没起草', description: got.refused);
    _saved = got.issue;
    return got.issue;
  }

  Future<Issue> save(IssueRequest draft, {List<String>? criteria}) async {
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
              criteria: criteria,
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

  Future<Issue> start(IssueRequest draft, {List<String>? criteria}) async {
    final issue = await save(draft, criteria: criteria);
    return api.status(
      id: issue.id,
      body: const IssueStatusRequest(status: IssueStatus.todo),
    );
  }

  /// Its edits saved first, so the drafter reads the draft as the owner left it.
  Future<Issue> draft(IssueRequest edits, String word, {List<String>? criteria, bool edited = false}) async {
    final issue = edited ? await save(edits, criteria: criteria) : _saved!;
    return api.draft(
      id: issue.id,
      body: IssueDraftRequest(text: word.trim()),
    );
  }
}
