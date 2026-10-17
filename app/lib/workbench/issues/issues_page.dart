import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../ui/kit/kit.dart';
import '../shared/layout.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import 'board.dart';
import 'issue_detail.dart';

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

const _lastPickKey = 'vibevalley.board.pick';

Future<(String, String)> lastPick() async {
  try {
    final raw = (await SharedPreferences.getInstance()).getStringList(_lastPickKey);
    if (raw != null && raw.length == 2) return (raw[0], raw[1]);
  } on Object {
    // No storage: nothing remembered.
  }
  return ('', '');
}

Future<void> rememberPick(String agent, String project) async {
  if (agent.isEmpty && project.isEmpty) return;
  try {
    await (await SharedPreferences.getInstance()).setStringList(_lastPickKey, [agent, project]);
  } on Object {
    // No storage: not remembered.
  }
}

void dispatchedNotice(Dispatched got, String issue, ValueChanged<String?> open) {
  if (got.session != null) {
    open(issue);
  } else if (got.queued case final why?) {
    toasts.add(type: ToastType.info, title: '排上队了', description: why);
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

  // Its sessions, oldest first: the ones on the farm and the ended (session.list).
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

/// A session session.list has not answered for yet stands in with what the issue knows.
List<Session> sessionsOf(Issue issue, Map<String, Session> heads) => [
  for (final id in issue.sessions)
    heads[id] ??
        Session(
          id: id,
          name: id,
          agent: issue.assignee ?? '',
          runtime: '',
          task: issue.title,
          project: issue.project,
          hiredAt: issue.createdAt,
          runs: 0,
          phase: const PhaseResting(),
        ),
];

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

class PlaybookCard extends BoardCard {
  const PlaybookCard(this.playbook, this.lane);
  final Playbook playbook;
  @override
  final Lane lane;
  @override
  String get id => 'playbook:${playbook.id}';
  @override
  String? get project => playbook.project;
  @override
  String? get agent => null;
  @override
  List<String?> get words => [playbook.title, playbook.goal, playbook.project, playbook.id];
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

class IssuesPage extends ConsumerStatefulWidget {
  const IssuesPage({super.key, this.id, this.project});

  final String? id;

  final String? project;

  @override
  ConsumerState<IssuesPage> createState() => _IssuesPageState();
}

String _sessionsKey(CoreState? farm) => [for (final i in farm?.issues ?? const <Issue>[]) '${i.id}:${i.sessions.join(',')}:${i.closedAt}'].join(';');

class _IssuesPageState extends ConsumerState<IssuesPage> {
  Map<String, Session>? _heads;

  List<Issue>? _history;
  BoardFilter _filter = const BoardFilter();
  bool _older = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> _load() async {
    try {
      final heads = await _api.session.list();
      if (mounted) setState(() => _heads = {for (final h in heads) h.id: h});
    } on Object catch (e) {
      debugPrint('vibevalley: issues: $e');
    }
  }

  Future<void> _toggleOlder() async {
    setState(() => _older = !_older);
    if (!_older) return;
    final all = await runAction(_api.issue.list);
    if (all != null && mounted) setState(() => _history = all);
  }

  void _open(String? id) => workbenchGo(context, id == null ? '/issues' : '/issues/${Uri.encodeComponent(id)}');

  /// Asked about first where it cannot be undone. A 待办 dropped back on its own lane goes last.
  Future<void> _drop(BoardCard card, Lane to) async {
    if (card is TodoCard && to == Lane.todo) return _place(card, null);
    switch ((cardMove(card, to), card)) {
      case (Move.start, TodoCard(:final item)) when item.assignee == null || item.project == null:
        _open(item.id);
        toasts.add(type: ToastType.info, title: '还差一点', description: '选好派哪个帮工、在哪个项目里做，再点「开工」。');
      case (Move.start, TodoCard(:final item)):
        final got = await runAction(() => _api.issue.start(id: item.id));
        await _load();
        if (got != null) dispatchedNotice(got, item.id, _open);
      case (Move.close, IssueCard(:final issue, :final session?)):
        await showFarmDialog<void>(
          context,
          title: Text('关上「${issueTitle(issue)}」'),
          size: FarmDialogSize.lg,
          icon: 'icon-harvest',
          builder: (_) => CloseIssue(session: session),
        );
        await _load();
      case (Move.reopen, IssueCard(:final issue)):
        final text = await showPxDialog<String>(
          context,
          title: const Text('重开这张工单'),
          builder: (_) => ReopenForm(issue: issue),
        );
        if (text == null) return;
        final got = await runAction(
          () => _api.issue.reopen(
            id: issue.id,
            body: ReopenRequest(text: text),
          ),
        );
        await _load();
        if (got?.session != null) _open(issue.id);
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

  Future<void> _add(String text) async {
    final f = _filter;
    final (lastAgent, lastProject) = await lastPick();
    final agent = f.agent.isNotEmpty ? f.agent : lastAgent;
    final project = f.project.isNotEmpty ? f.project : lastProject;
    await runAction(
      () => _api.issue.create(
        body: IssueRequest(title: text, project: project.isEmpty ? null : project, assignee: agent.isEmpty ? null : agent),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(stateProvider);
    ref.listen(stateProvider.select(_sessionsKey), (_, _) => unawaited(_load()));
    final heads = _heads;
    final kept = farm?.issues ?? const <Issue>[];
    final issues = [
      ...kept,
      for (final old in _history ?? const <Issue>[])
        if (old.closedAt != null && !kept.any((i) => i.id == old.id)) old,
    ];
    final plans = ref.watch(plansProvider);
    final all = <BoardCard>[
      // A playbook is its own card (below); a step of one is on the board once a helper has worked it.
      for (final issue in issues)
        if (isForManager(issue))
          ManagerCard(issue)
        else if (issue.plan == null && (issue.parent == null || issue.sessions.isNotEmpty))
          issue.sessions.isEmpty ? TodoCard(issue) : IssueCard(issue, sessionsOf(issue, heads ?? const {}), issueTag(issue), issueSession(farm, issue)),
      for (final p in plans)
        if (playbookLane(p) case final lane?) PlaybookCard(p, lane),
    ];
    final id = widget.id;
    final open = id == null ? null : all.where((c) => c.id == id || (c is IssueCard && issueIs(c.issue, id))).firstOrNull;
    final Widget? detail = switch (open) {
      _ when id == 'new' => TodoDetail(key: ValueKey('new:${widget.project}'), item: null, project: widget.project, reload: _load, onDone: _open),
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
      PlaybookCard() || null => null,
    };
    return LayoutBuilder(
      builder: (context, box) {
        final board = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Toolbar(filter: _filter, cards: all, shown: all.where(_filter.shows).length, onChanged: (f) => setState(() => _filter = f)),
            const SizedBox(height: 8),
            Expanded(
              child: IssueBoard(
                cards: all.where(_filter.shows).toList(),
                loading: farm == null,
                selected: open?.id ?? id,
                older: _older,
                onOlder: () => unawaited(_toggleOlder()),
                onOpen: _open,
                onDrop: _drop,
                onPlace: _place,
                onAdd: _add,
              ),
            ),
          ],
        );
        if (detail == null) return board;
        final side = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: InlineLink(box.maxWidth >= sideBySideFrom ? '收起' : '回看板', onTap: () => _open(null)),
            ),
            const SizedBox(height: 6),
            Expanded(child: PxScrollView(child: detail)),
          ],
        );
        if (box.maxWidth < sideBySideFrom) {
          return Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 12), child: side);
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: board),
            SizedBox(
              width: 480,
              child: Padding(padding: const EdgeInsets.fromLTRB(0, 0, 12, 12), child: side),
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
          SizedBox(
            width: 240,
            child: PxTextInput(
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
            child: PxPick(
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
            child: PxPick(
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
          if (filter.any) ...[
            Text('$shown / ${cards.length} 张', style: KitText.xs.copyWith(color: Palette.bark500)),
            InlineLink('清掉筛选', onTap: () => onChanged(const BoardFilter())),
          ],
        ],
      ),
    );
  }
}
