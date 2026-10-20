import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../ui/pro/pro.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import 'board.dart';
import 'issue_detail.dart';
import 'issue_panel.dart' show IssueHeading;
import 'issue_submission.dart';

/// From this wide, a card opens beside the board; narrower, over it.
Color issueTagColor(IssueTag s) => switch (s) {
  IssueTag.working => Palette.water,
  IssueTag.waiting => Palette.wheat,
  IssueTag.harvested || IssueTag.merged || IssueTag.answered => Palette.leaf500,
  IssueTag.dropped || IssueTag.closed => Palette.cream300,
  IssueTag.lost => Palette.berry,
};

const priorityLabel = {Priority.urgent: '紧急', Priority.high: '高', Priority.medium: '普通', Priority.low: '低'};

Color? priorityColor(Priority p) => switch (p) {
  Priority.urgent => Palette.berry,
  Priority.high => Palette.wheat,
  Priority.medium => null,
  Priority.low => Palette.cream300,
};

/// Moved to todo: it is either worked already, or waits there for room.
void dispatchedNotice(Issue got, ValueChanged<String?> open) {
  if (got.status == IssueStatus.todo) {
    toasts.add(type: ToastType.info, title: '排上队了', description: '地都满了，有空地就自动开工。');
  } else {
    open(got.id);
  }
}

sealed class BoardCard {
  const BoardCard();
  String get id;
  Lane get lane;
  String? get project;
  String? get agent;

  List<String?> get words;
}

class TodoCard extends BoardCard {
  const TodoCard(this.item);
  final Issue item;
  @override
  String get id => item.id;
  @override
  Lane get lane => Lane.todo;
  @override
  String? get project => item.project;
  @override
  String? get agent => item.assignee;
  @override
  List<String?> get words => [item.title, item.description, item.project];
}

class IssueCard extends BoardCard {
  const IssueCard(this.issue, this.sessions, this.state, this.session);
  final Issue issue;

  // Real live and ended sessions, in the issue history query's order.
  final List<Session> sessions;
  final IssueTag state;
  final Session? session;

  Session get head => sessions.last;
  @override
  String get id => issue.id;
  @override
  Lane get lane => laneOf(issue.status);
  @override
  String? get project => issue.project;
  @override
  String? get agent => issue.assignee;
  @override
  List<String?> get words => [issue.title, issue.description, head.name, issue.project, issue.id, head.lastRun?.summary];
}

class MissingSessionCard extends BoardCard {
  const MissingSessionCard(this.history);
  final IssueHistory history;
  Issue get issue => history.issue;
  @override
  String get id => issue.id;
  @override
  Lane get lane => laneOf(issue.status);
  @override
  String? get project => issue.project;
  @override
  String? get agent => issue.assignee;
  @override
  List<String?> get words => [issue.title, issue.description, issue.project];
}

/// An issue for the manager: open while the manager works on it, closed once it has answered; never dragged.
class ManagerCard extends BoardCard {
  const ManagerCard(this.issue);
  final Issue issue;
  @override
  String get id => issue.id;
  @override
  Lane get lane => laneOf(issue.status);
  @override
  String? get project => issue.project;
  @override
  String? get agent => issue.assignee;
  @override
  List<String?> get words => [issue.title, issue.description, issue.project, issue.id, '管家'];
}

class TaskCard extends BoardCard {
  const TaskCard(this.graph, this.lane);
  final TaskGraph graph;
  @override
  final Lane lane;
  @override
  String get id => 'task:${graph.id}';
  @override
  String? get project => graph.project;
  @override
  String? get agent => null;
  @override
  List<String?> get words => [graph.title, graph.goal, graph.project, graph.id];
}

class BoardFilter {
  const BoardFilter({this.query = '', this.project = '', this.agent = ''});
  final String query;
  final String project;
  final String agent;

  bool get any => query.trim().isNotEmpty || project.isNotEmpty || agent.isNotEmpty;

  bool shows(BoardCard c) => (project.isEmpty || c.project == project) && (agent.isEmpty || c.agent == agent) && matchesQuery(query, c.words);

  BoardFilter copyWith({String? query, String? project, String? agent}) =>
      BoardFilter(query: query ?? this.query, project: project ?? this.project, agent: agent ?? this.agent);
}

/// The plus without words: an issue made at once in the backlog and opened, its box asking what it is for.
Future<void> writeIssueAndOpen(BuildContext context, VibeValleyApi api, {String project = ''}) async {
  final made = await runAction(() => IssueSubmission(api.issue).write('', project: project));
  if (made != null && context.mounted) workbenchGo(context, '/issues/${Uri.encodeComponent(made.id)}');
}

class IssuesPage extends ConsumerStatefulWidget {
  const IssuesPage({super.key, this.id});

  final String? id;

  @override
  ConsumerState<IssuesPage> createState() => _IssuesPageState();
}

class _IssuesPageState extends ConsumerState<IssuesPage> {
  BoardFilter _filter = const BoardFilter();
  bool _older = false;

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> _load() async {
    ref.invalidate(issueHistoryProvider);
    await ref.read(issueHistoryProvider.future);
  }

  void _toggleOlder() => setState(() => _older = !_older);

  void _open(String? id) => workbenchGo(context, id == null ? '/issues' : '/issues/${Uri.encodeComponent(id)}');

  /// Asked about first where it cannot be undone. A 待办 dropped back on its own lane goes last.
  Future<void> _drop(BoardCard card, Lane to) async {
    if (card is TodoCard && to == Lane.todo) return _place(card, null);
    switch ((cardMove(card, to), card)) {
      case (Move.start, TodoCard(:final item)) when item.assignee == null || item.project == null:
        _open(item.id);
        toasts.add(type: ToastType.info, title: '还差一点', description: '选好派哪个帮工、在哪个项目里做，再点「开工」。');
      case (Move.start, TodoCard(:final item)):
        final got = await runAction(
          () => _api.issue.status(
            id: item.id,
            body: const IssueStatusRequest(status: IssueStatus.todo),
          ),
        );
        await _load();
        if (got != null) dispatchedNotice(got, _open);
      case (Move.close, IssueCard(:final issue, :final session?)):
        await showCloseIssueDialog(context, issue, session);
        await _load();
      case (Move.reopen, IssueCard(:final issue)):
        final text = await showProDialog<String>(
          context,
          title: const Text('重开这张工单'),
          builder: (_) => ReopenForm(issue: issue),
        );
        if (text == null) return;
        final got = await runAction(
          () => _api.issue.status(
            id: issue.id,
            body: IssueStatusRequest(status: IssueStatus.todo, text: text),
          ),
        );
        await _load();
        if (got != null) _open(issue.id);
      default:
        return;
    }
  }

  Future<void> _place(TodoCard card, String? before) async {
    if (card.id == before) return;
    await runAction(
      () => _api.issue.move(
        id: card.id,
        body: MoveIssueRequest(before: before),
      ),
    );
  }

  /// The plus: the sentence is the issue, its draft starts from it, and it opens.
  Future<void> _add(String text) async {
    final made = await runAction(() => IssueSubmission(_api.issue).write(text, agent: _filter.agent, project: _filter.project));
    if (made != null) _open(made.id);
  }

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(stateProvider);
    final history = ref.watch(visibleIssueHistoryProvider(_older));
    final entries = history.value ?? const <IssueHistory>[];
    final graphs = ref.watch(graphsProvider);
    final all = <BoardCard>[
      // A task is its own card (below); a step of one is on the board once a helper has worked it.
      for (final row in entries)
        if (isForManager(row.issue))
          ManagerCard(row.issue)
        else if (row.issue.graph == null && (row.issue.parent == null || row.issue.sessions.isNotEmpty))
          row.issue.sessions.isEmpty
              ? TodoCard(row.issue)
              : row.missingSessions.isNotEmpty || row.sessions.isEmpty
              ? MissingSessionCard(row)
              : IssueCard(row.issue, row.sessions, issueTag(row.issue), issueSession(farm, row.issue)),
      // A task's lane is its parent issue's status, which the server works out from the task's state.
      for (final row in entries)
        if (row.issue.graph != null && laneOf(row.issue.status) != Lane.closed)
          if (graphs.where((p) => p.id == row.issue.id).firstOrNull case final p?) TaskCard(p, laneOf(row.issue.status)),
    ];
    final id = widget.id;
    final open = id == null ? null : all.where((c) => c.id == id || (c is IssueCard && issueIs(c.issue, id))).firstOrNull;
    final Widget? detail = switch (open) {
      TodoCard(:final item) => TodoDetail(key: ValueKey(item.id), item: item, reload: _load, onDone: _open),
      IssueCard(:final issue, :final sessions, :final state, :final session) => IssueDetail(
        key: ValueKey(sessions.last.id),
        issue: issue,
        sessions: sessions,
        state: state,
        session: session,
        reload: _load,
      ),
      ManagerCard(:final issue) => ManagerIssueDetail(key: ValueKey(issue.id), issue: issue),
      MissingSessionCard(:final history) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          IssueHeading(history.issue.title, big: true),
          const SizedBox(height: 12),
          Text('执行记录缺失：${history.missingSessions.join('、')}。执行动作暂不可用。', style: ProText.sm),
        ],
      ),
      TaskCard() => null,
      // A link to an issue the farm does not have says so, instead of quietly showing the board.
      null when id != null && farm != null && history.hasValue && !history.isLoading && !history.hasError => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const IssueHeading('找不到这张工单'),
          const SizedBox(height: 12),
          Text('农场里没有 $id：可能已经删掉了，或者链接写错了。', style: ProText.sm.copyWith(color: ProColor.muted)),
        ],
      ),
      null => null,
    };
    return LayoutBuilder(
      builder: (context, box) {
        final board = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (history.hasError) Text('工单记录没读到：${reasonOf(history.error!)}', style: ProText.sm.copyWith(color: Palette.berry)),
            _Toolbar(filter: _filter, cards: all, shown: all.where(_filter.shows).length, onChanged: (f) => setState(() => _filter = f)),
            const SizedBox(height: 8),
            Expanded(
              child: IssueBoard(
                cards: all.where(_filter.shows).toList(),
                loading: farm == null || history.isLoading,
                selected: open?.id ?? id,
                older: _older,
                onOlder: _toggleOlder,
                onOpen: _open,
                onDrop: _drop,
                onPlace: _place,
                onAdd: _add,
                onWrite: () => writeIssueAndOpen(context, ref.read(apiProvider)),
              ),
            ),
          ],
        );
        if (detail == null) return board;
        return Stack(
          children: [
            Positioned.fill(child: board),
            Positioned.fill(
              child: ProModalLayer(onClose: () => _open(null), maxWidth: 1080, child: detail),
            ),
          ],
        );
      },
    );
  }
}

class _Toolbar extends ConsumerWidget {
  const _Toolbar({required this.filter, required this.cards, required this.shown, required this.onChanged});
  final BoardFilter filter;
  final List<BoardCard> cards;
  final int shown;
  final ValueChanged<BoardFilter> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agents = ref.watch(workbenchConfigProvider).agents;
    final projects = {for (final c in cards) ?c.project}.toList()..sort();
    final used = {for (final c in cards) ?c.agent};
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (ref.watch(workbenchConfigProvider).error != null) const ConfigProblem(),
          SizedBox(
            width: 240,
            child: ProTextInput(
              value: filter.query,
              onChanged: (v) => onChanged(filter.copyWith(query: v)),
              placeholder: '找工单：标题、帮工、项目',
              semanticLabel: '找工单',
              icon: 'button-search',
            ),
          ),
          const SpriteIcon('button-filter', size: 16, semanticLabel: '筛选'),
          SizedBox(
            width: 170,
            child: ProPick(
              value: filter.project,
              placeholder: '所有项目',
              semanticLabel: '按项目看',
              options: [
                const PickOption(value: '', label: '所有项目'),
                for (final p in projects) PickOption(value: p, label: p),
              ],
              onChanged: (v) => onChanged(filter.copyWith(project: v)),
            ),
          ),
          SizedBox(
            width: 170,
            child: ProPick(
              value: filter.agent,
              placeholder: '所有帮工',
              semanticLabel: '按帮工看',
              options: [
                const PickOption(value: '', label: '所有帮工'),
                for (final a in agents)
                  if (used.contains(a.id)) PickOption(value: a.id, label: a.name),
              ],
              onChanged: (v) => onChanged(filter.copyWith(agent: v)),
            ),
          ),
          if (filter.any) ...[Text('$shown / ${cards.length} 张', style: ProText.meta), InlineLink('清掉筛选', onTap: () => onChanged(const BoardFilter()))],
        ],
      ),
    );
  }
}
