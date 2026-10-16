import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/providers.dart';
import '../../farm/bits.dart' show AgentFace, Ticking;
import '../../farm/harvest.dart' show HarvestReview;
import '../../game/commands.dart' show farmCommandsProvider;
import '../../game/state.dart' show FarmPanel, panelProvider, planShownProvider, selectedProvider;
import '../../gen/vibevalley.dart';
import '../../rules/index.dart' show IssueLevel, agentIssues, conflictTask;
import '../../rules/rounds.dart' show roundsOf, tookText;
import '../../rules/tickets.dart';
import '../../shell/title/title_state.dart' show titleOpenProvider;
import '../../ui/kit/kit.dart';
import '../../village/village_view.dart' show runtimesProvider;
import '../runtimes/layout.dart';
import '../projects/new_project_dialog.dart' show showNewProjectDialog;
import '../shared/state.dart';
import '../shared/widgets.dart';
import '../shared/work_log.dart';

/// From this wide, a card opens beside the board; narrower, over it.
const _sideBySide = 1100.0;

Color ticketColor(TicketState s) => switch (s) {
  TicketState.working => Palette.water,
  TicketState.waiting => Palette.wheat,
  TicketState.harvested || TicketState.merged => Palette.leaf500,
  TicketState.dropped || TicketState.closed => Palette.cream300,
  TicketState.lost => Palette.berry,
};

const priorityLabel = {Priority.urgent: '紧急', Priority.high: '高', Priority.normal: '普通', Priority.low: '低'};

Color? priorityColor(Priority p) => switch (p) {
  Priority.urgent => Palette.berry,
  Priority.high => Palette.wheat,
  Priority.normal => null,
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
  if (got.helper != null) {
    open(issue);
  } else if (got.queued case final why?) {
    toasts.add(type: ToastType.info, title: '排上队了', description: why);
  }
}

final _agentsProvider = FutureProvider<List<AgentProfile>>((ref) => ref.watch(deskApiProvider).farm.agents());

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
  String? get agent => item.agent;
  @override
  List<String?> get words => [item.title, item.description, item.project];
}

class TicketCard extends BoardCard {
  const TicketCard(this.issue, this.runs, this.state, this.helper);
  final Issue issue;

  final List<TrajectoryHead> runs;
  final TicketState state;
  final Helper? helper;

  TrajectoryHead get head => runs.last;
  @override
  String get id => issue.id;
  @override
  Lane get lane => laneOf(state);
  @override
  String? get project => issue.project;
  @override
  String? get agent => issue.agent;
  @override
  List<String?> get words => [issue.title, issue.description, head.name, issue.project, issue.id, head.summary];
}

List<TrajectoryHead> runsOf(Issue issue, Map<String, TrajectoryHead> heads) => [
  for (final id in issue.runs) heads[id] ?? TrajectoryHead(id: id, name: id, agent: issue.agent, project: issue.project, startedAt: issue.createdAt),
];

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

Move? _moveOf(BoardCard card, Lane to) => switch (card) {
  PlaybookCard() => null,
  TodoCard() => moveOf(card.lane, to),
  TicketCard(:final issue, :final helper) => moveOf(card.lane, to, planned: ticketPlanned(issue, helper)),
};

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

class TicketsPage extends ConsumerStatefulWidget {
  const TicketsPage({super.key, this.id, this.project});

  final String? id;

  final String? project;

  @override
  ConsumerState<TicketsPage> createState() => _TicketsPageState();
}

String _runsKey(FarmState? farm) => [for (final i in farm?.issues ?? const <Issue>[]) '${i.id}:${i.runs.join(',')}:${i.closedAt}'].join(';');

class _TicketsPageState extends ConsumerState<TicketsPage> {
  Map<String, TrajectoryHead>? _heads;

  List<Issue>? _history;
  BoardFilter _filter = const BoardFilter();
  bool _older = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  FarmApi get _farm => ref.read(deskApiProvider).farm;

  Future<void> _load() async {
    try {
      final heads = await _farm.trajectories();
      if (mounted) setState(() => _heads = {for (final h in heads) h.id: h});
    } on Object catch (e) {
      debugPrint('vibevalley: tickets: $e');
    }
  }

  Future<void> _toggleOlder() async {
    setState(() => _older = !_older);
    if (!_older) return;
    final all = await deskRun(_farm.issues);
    if (all != null && mounted) setState(() => _history = all);
  }

  void _open(String? id) => deskGo(context, id == null ? '/tickets' : '/tickets/${Uri.encodeComponent(id)}');

  /// Asked about first where it cannot be undone. A 待办 dropped back on its own lane goes last.
  Future<void> _drop(BoardCard card, Lane to) async {
    if (card is TodoCard && to == Lane.todo) return _place(card, null);
    switch ((_moveOf(card, to), card)) {
      case (Move.start, TodoCard(:final item)) when item.agent == null || item.project == null:
        _open(item.id);
        toasts.add(type: ToastType.info, title: '还差一点', description: '选好派哪个帮工、在哪个项目里做，再点「开工」。');
      case (Move.start, TodoCard(:final item)):
        final got = await deskRun(() => _farm.startIssue(id: item.id));
        await _load();
        if (got != null) dispatchedNotice(got, item.id, _open);
      case (Move.close, TicketCard(:final issue, :final helper?)):
        await showFarmDialog<void>(
          context,
          title: Text('关上「${ticketTitle(issue)}」'),
          size: FarmDialogSize.lg,
          icon: 'icon-harvest',
          builder: (_) => _CloseTicket(helper: helper),
        );
        await _load();
      case (Move.reopen, TicketCard(:final issue)):
        final text = await showPxDialog<String>(
          context,
          title: const Text('重开这张工单'),
          builder: (_) => _ReopenForm(issue: issue),
        );
        if (text == null) return;
        final got = await deskRun(
          () => _farm.reopen(
            id: issue.id,
            body: ReopenRequest(text: text),
          ),
        );
        await _load();
        if (got?.helper != null) _open(issue.id);
      default:
        return;
    }
  }

  Future<void> _place(TodoCard card, String? before) async {
    if (card.id == before) return;
    await deskRun(
      () => _farm.moveIssue(
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
    await deskRun(
      () => _farm.addIssue(
        body: IssueRequest(title: text, project: project.isEmpty ? null : project, agent: agent.isEmpty ? null : agent),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(farmProvider);
    ref.listen(farmProvider.select(_runsKey), (_, _) => unawaited(_load()));
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
        if (issue.plan == null && (issue.parent == null || issue.runs.isNotEmpty))
          issue.runs.isEmpty ? TodoCard(issue) : TicketCard(issue, runsOf(issue, heads ?? const {}), ticketState(issue), ticketHelper(farm, issue)),
      for (final p in plans)
        if (playbookLane(p) case final lane?) PlaybookCard(p, lane),
    ];
    final id = widget.id;
    final open = id == null ? null : all.where((c) => c.id == id || (c is TicketCard && ticketIs(c.issue, id))).firstOrNull;
    final Widget? detail = switch (open) {
      _ when id == 'new' => _Todo(key: ValueKey('new:${widget.project}'), item: null, project: widget.project, reload: _load, onDone: _open),
      TodoCard(:final item) => _Todo(key: ValueKey(item.id), item: item, reload: _load, onDone: _open),
      TicketCard(:final issue, :final runs, :final state, :final helper) => _Ticket(
        key: ValueKey(runs.last.id),
        issue: issue,
        runs: runs,
        state: state,
        helper: helper,
        reload: _load,
      ),
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
              child: _Board(
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
              child: DeskLink(box.maxWidth >= _sideBySide ? '收起' : '回看板', onTap: () => _open(null)),
            ),
            const SizedBox(height: 6),
            Expanded(child: PxScrollView(child: detail)),
          ],
        );
        if (box.maxWidth < _sideBySide) {
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
    final agents = ref.watch(_agentsProvider).value ?? const <AgentProfile>[];
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
            DeskLink('清掉筛选', onTap: () => onChanged(const BoardFilter())),
          ],
        ],
      ),
    );
  }
}

class _Board extends StatefulWidget {
  const _Board({
    required this.cards,
    required this.loading,
    required this.selected,
    required this.older,
    required this.onOlder,
    required this.onOpen,
    required this.onDrop,
    required this.onPlace,
    required this.onAdd,
  });
  final List<BoardCard> cards;
  final bool loading;
  final String? selected;
  final bool older;
  final VoidCallback onOlder;
  final ValueChanged<String?> onOpen;
  final Future<void> Function(BoardCard card, Lane to) onDrop;
  final Future<void> Function(TodoCard card, String? before) onPlace;
  final Future<void> Function(String text) onAdd;

  @override
  State<_Board> createState() => _BoardState();
}

const _oneLane = 700.0;

class _BoardState extends State<_Board> {
  Lane _lane = Lane.todo;

  Widget _laneView(Lane lane) => _LaneView(
    lane: lane,
    cards: [
      for (final c in widget.cards)
        if (c.lane == lane) c,
    ],
    loading: widget.loading,
    selected: widget.selected,
    older: widget.older,
    onOlder: widget.onOlder,
    onOpen: widget.onOpen,
    onDrop: widget.onDrop,
    onPlace: widget.onPlace,
    onAdd: widget.onAdd,
  );

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      if (box.maxWidth < _oneLane) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PxSegmented<Lane>(
                value: _lane,
                options: [for (final l in Lane.values) SegmentOption(value: l, label: '${l.label} ${widget.cards.where((c) => c.lane == l).length}')],
                onChanged: (l) => setState(() => _lane = l),
              ),
              const SizedBox(height: 8),
              Expanded(child: _laneView(_lane)),
            ],
          ),
        );
      }
      // Four lanes fit beside an open card on a laptop's screen; narrower, the board scrolls sideways.
      const least = 200.0;
      final width = ((box.maxWidth - 24 - 3 * 10) / 4).clamp(least, double.infinity);
      final lanes = Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, lane) in Lane.values.indexed) ...[if (i > 0) const SizedBox(width: 10), SizedBox(width: width, child: _laneView(lane))],
        ],
      );
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        child: width * 4 + 30 > box.maxWidth - 24 ? SingleChildScrollView(scrollDirection: Axis.horizontal, child: lanes) : lanes,
      );
    },
  );
}

class _LaneView extends StatelessWidget {
  const _LaneView({
    required this.lane,
    required this.cards,
    required this.loading,
    required this.selected,
    required this.older,
    required this.onOlder,
    required this.onOpen,
    required this.onDrop,
    required this.onPlace,
    required this.onAdd,
  });
  final Lane lane;
  final List<BoardCard> cards;
  final bool loading;
  final String? selected;
  final bool older;
  final VoidCallback onOlder;
  final ValueChanged<String?> onOpen;
  final Future<void> Function(BoardCard card, Lane to) onDrop;
  final Future<void> Function(TodoCard card, String? before) onPlace;
  final Future<void> Function(String text) onAdd;

  @override
  Widget build(BuildContext context) {
    var shown = cards;
    var hidden = 0;
    if (lane == Lane.closed) {
      shown = [...cards]
        ..sort((a, b) {
          final at = (a as TicketCard).issue.closedAt ?? a.head.startedAt;
          final bt = (b as TicketCard).issue.closedAt ?? b.head.startedAt;
          return bt.compareTo(at);
        });
      if (!older && shown.length > closedShown) {
        hidden = shown.length - closedShown;
        shown = shown.take(closedShown).toList();
      }
    }
    final head = switch (lane) {
      Lane.working => '${cards.whereType<TicketCard>().length} / $workingBeds 块地',
      _ => '${cards.length}',
    };
    return DragTarget<BoardCard>(
      onWillAcceptWithDetails: (d) => _moveOf(d.data, lane) != null || (lane == Lane.todo && d.data is TodoCard),
      onAcceptWithDetails: (d) => unawaited(onDrop(d.data, lane)),
      builder: (context, coming, refused) => Container(
        decoration: BoxDecoration(
          color: coming.isNotEmpty ? Palette.leaf300.withValues(alpha: .35) : Palette.cream100,
          border: Border.all(color: coming.isNotEmpty ? Palette.leaf600 : Palette.cream300, width: 2),
        ),
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(lane.label, style: KitText.sm.copyWith(color: Palette.bark900)),
                const SizedBox(width: 6),
                Text(head, style: KitText.xs.copyWith(color: Palette.bark500)),
                const Spacer(),
                if (lane == Lane.todo)
                  PxButton(
                    size: PxSize.custom,
                    padding: const EdgeInsets.all(4),
                    tooltip: '详细写一张',
                    semanticLabel: '详细写一张',
                    onPressed: () => onOpen('new'),
                    child: const SpriteIcon('button-edit', size: 14),
                  ),
              ],
            ),
            if (lane == Lane.todo) ...[const SizedBox(height: 6), _QuickAdd(onAdd: onAdd)],
            const SizedBox(height: 8),
            Expanded(
              child: loading
                  ? const DeskEmpty('在读……')
                  : cards.isEmpty
                  ? Text(_emptyText[lane]!, style: KitText.xs.copyWith(color: Palette.bark400, height: 1.625))
                  : ListView.separated(
                      itemCount: shown.length + (hidden > 0 || (older && cards.length > closedShown) ? 1 : 0),
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (context, i) {
                        if (i == shown.length) {
                          return Center(child: DeskLink(hidden > 0 ? '更早的 $hidden 张' : '只看最近的', onTap: onOlder));
                        }
                        final card = shown[i];
                        final view = _CardView(card: card, selected: card.id == selected, onOpen: onOpen);
                        return card is TodoCard ? _PlaceBefore(card: card, onPlace: onPlace, child: view) : view;
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

const _emptyText = {
  Lane.todo: '想到要做的先写在这里，拖到「处理中」就派人开工；上下拖排先后。',
  Lane.working: '没有在干的活。',
  Lane.waiting: '做完的、没做成的在这里等你看；拖到「已关」收获或收工。',
  Lane.closed: '关了的工单；拖回「处理中」重开。',
};

class _PlaceBefore extends StatelessWidget {
  const _PlaceBefore({required this.card, required this.onPlace, required this.child});
  final TodoCard card;
  final Future<void> Function(TodoCard card, String? before) onPlace;
  final Widget child;

  @override
  Widget build(BuildContext context) => DragTarget<BoardCard>(
    onWillAcceptWithDetails: (d) => d.data is TodoCard && d.data.id != card.id,
    onAcceptWithDetails: (d) => unawaited(onPlace(d.data as TodoCard, card.id)),
    builder: (context, coming, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (coming.isNotEmpty) Container(height: 4, margin: const EdgeInsets.only(bottom: 4), color: Palette.leaf600),
        child,
      ],
    ),
  );
}

class _QuickAdd extends StatefulWidget {
  const _QuickAdd({required this.onAdd});
  final Future<void> Function(String text) onAdd;

  @override
  State<_QuickAdd> createState() => _QuickAddState();
}

class _QuickAddState extends State<_QuickAdd> {
  String _text = '';
  // A new key empties the field after a 待办 goes in.
  int _round = 0;

  Future<void> _submit() async {
    final text = _text.trim();
    if (text.isEmpty) return;
    setState(() {
      _text = '';
      _round++;
    });
    await widget.onAdd(text);
  }

  @override
  Widget build(BuildContext context) => PxTextInput(
    key: ValueKey(_round),
    value: _text,
    onChanged: (v) => setState(() => _text = v),
    onSubmitted: (_) => _submit(),
    placeholder: '＋ 写一张，回车存下',
    semanticLabel: '写一张待办',
  );
}

class _CardView extends ConsumerWidget {
  const _CardView({required this.card, required this.selected, required this.onOpen});
  final BoardCard card;
  final bool selected;
  final ValueChanged<String?> onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agents = ref.watch(_agentsProvider).value ?? const <AgentProfile>[];
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final xs = KitText.xs.copyWith(color: Palette.bark500);
    final (title, who, stripe) = switch (card) {
      PlaybookCard(:final playbook) => ('计划：${playbook.title}', '${playbook.nodes.length} 步', null),
      TodoCard(:final item) => (item.title, agents.where((a) => a.id == item.agent).firstOrNull?.name ?? '还没选帮工', priorityColor(item.priority)),
      TicketCard(:final issue, :final head) => (ticketTitle(issue, ref.watch(plansProvider)), head.name, null),
    };
    final tags = <Widget>[];
    final lines = <Widget>[];
    switch (card) {
      case PlaybookCard(:final playbook):
        tags.add(const _Tag('种植计划', Palette.leaf500));
        lines.add(Text(playbookLine(playbook), style: KitText.xs.copyWith(color: playbook.state == PlaybookState.ripe ? Palette.leaf700 : Palette.bark800)));
      case TodoCard(:final item):
        if (item.queuedAt != null) tags.add(const _Tag('排队中', Palette.water));
        if (item.schedule != null) tags.add(const _Tag('定时', Palette.cream300));
        if (item.priority == Priority.urgent || item.priority == Priority.high) tags.add(_Tag(priorityLabel[item.priority]!, priorityColor(item.priority)!));
        if (item.agent == null || item.project == null) tags.add(const _Tag('没选帮工或项目', Palette.cream300));
        lines.add(Text(item.queuedAt != null ? '等空地，${ago(item.queuedAt!, now)}排上的' : '写于 ${ago(item.createdAt, now)}', style: xs));
      case TicketCard(:final issue, :final runs, :final head, :final state, :final helper):
        final phase = helper?.phase;
        if (helper?.conflict != null) tags.add(const _Tag('冲突', Palette.berry));
        if (phase is PhaseWorking && phase.quietSince != null) tags.add(_Tag('${tookText(now - phase.quietSince!)}没动静', Palette.wheat));
        if (phase is PhaseFailed || (helper?.last?.outcome ?? head.outcome) == Outcome.failed) tags.add(const _Tag('没做成', Palette.berry));
        if (state == TicketState.lost) tags.add(const _Tag('丢了', Palette.berry));
        if (runs.length > 1) tags.add(_Tag('第 ${runs.length} 次', Palette.water));
        if (issue.schedule != null) tags.add(const _Tag('定时', Palette.cream300));
        if (ticketPlanned(issue, helper)) tags.add(const _Tag('种植计划', Palette.leaf500));
        final turns = (helper?.turns ?? head.turns ?? 0).round();
        final cny = helper?.spent?.cny ?? head.cny;
        final took = state.open ? '开了 ${tookText(now - head.startedAt)}' : '用了 ${tookText((issue.closedAt ?? head.endedAt ?? now) - runs.first.startedAt)}';
        lines.add(
          Text(
            [if (state == TicketState.working) '第 ${turns + 1} 轮' else '$turns 轮', took, if (cny != null) '¥${cny.toStringAsFixed(2)}'].join(' · '),
            style: xs,
          ),
        );
        final said = helper?.last?.summary ?? head.summary;
        if (state == TicketState.waiting && said != null && said.isNotEmpty) {
          lines.add(
            Text(
              said,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: KitText.xs.copyWith(color: Palette.bark800, height: 1.5),
            ),
          );
        }
        if (!state.open) lines.add(Text('${state.label} · ${ago(issue.closedAt ?? head.endedAt ?? head.startedAt, now)}', style: xs));
    }
    Widget face(double opacity) => Opacity(
      opacity: opacity,
      child: Container(
        decoration: BoxDecoration(
          color: Palette.cream50,
          border: Border(
            left: BorderSide(color: stripe ?? (selected ? Palette.leaf600 : Palette.cream300), width: stripe != null ? 5 : 2),
            top: BorderSide(color: selected ? Palette.leaf600 : Palette.cream300, width: 2),
            right: BorderSide(color: selected ? Palette.leaf600 : Palette.cream300, width: 2),
            bottom: BorderSide(color: selected ? Palette.leaf600 : Palette.cream300, width: 2),
          ),
        ),
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (card case TicketCard(:final state)) ...[
                  Padding(padding: const EdgeInsets.only(top: 4), child: StateDot(ticketColor(state))),
                  const SizedBox(width: 6),
                ],
                if (card is PlaybookCard) ...[const Padding(padding: EdgeInsets.only(top: 4), child: StateDot(Palette.leaf500)), const SizedBox(width: 6)],
                Expanded(
                  child: Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.sm.copyWith(color: Palette.bark900),
                  ),
                ),
              ],
            ),
            if (tags.isNotEmpty) ...[const SizedBox(height: 6), Wrap(spacing: 4, runSpacing: 4, children: tags)],
            const SizedBox(height: 6),
            Row(
              children: [
                if (card.agent != null) ...[AgentFace(card.agent!, size: 18), const SizedBox(width: 4)],
                Flexible(
                  child: Text(
                    who,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.xs.copyWith(color: Palette.bark800),
                  ),
                ),
                if (card.project != null) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      card.project!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.mono.copyWith(fontSize: 10, color: Palette.bark500),
                    ),
                  ),
                ],
              ],
            ),
            for (final line in lines) ...[const SizedBox(height: 4), line],
          ],
        ),
      ),
    );
    if (card case PlaybookCard(:final playbook)) {
      return KitTappable(
        onTap: () {
          ref.read(planShownProvider.notifier).set(playbook.id);
          ref.read(panelProvider.notifier).set(FarmPanel.plans);
          ref.read(titleOpenProvider.notifier).enterFarm(start: false);
          deskGo(context, '/');
        },
        semanticLabel: title,
        builder: (context, s) => face(1),
      );
    }
    final tappable = KitTappable(onTap: () => onOpen(card.id), semanticLabel: title, builder: (context, s) => face(1));
    final feedback = Material(
      type: MaterialType.transparency,
      child: SizedBox(width: 240, child: face(.9)),
    );
    // A phone scrolls the lane with a drag: a card is picked up with a long press there.
    return Platform.isIOS || Platform.isAndroid
        ? LongPressDraggable<BoardCard>(data: card, feedback: feedback, childWhenDragging: face(.35), child: tappable)
        : Draggable<BoardCard>(data: card, feedback: feedback, childWhenDragging: face(.35), child: tappable);
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
    color: color.withValues(alpha: .2),
    child: Text(text, style: KitText.xs.copyWith(fontSize: 10, color: Palette.bark900)),
  );
}

class _CloseTicket extends ConsumerStatefulWidget {
  const _CloseTicket({required this.helper});
  final Helper helper;

  @override
  ConsumerState<_CloseTicket> createState() => _CloseTicketState();
}

class _CloseTicketState extends ConsumerState<_CloseTicket> {
  bool _review = false;

  @override
  Widget build(BuildContext context) {
    final helper = widget.helper;
    void done() => Navigator.of(context).pop();
    if (_review) return HarvestReview(worker: helper, onDone: done);
    final working = helper.phase is PhaseWorking || helper.phase is PhaseArriving;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          working ? '${helper.name} 还在干这张工单。关上就是叫停它、让它收工，分支上的改动不合进主分支。' : '收获就是把 ${helper.name} 的分支合进项目的主分支，先看一遍收成清单；不收就是让它收工，改动不合进去。',
          style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (!working) PxButton.text('看收成清单，收获', tone: PxTone.primary, onPressed: () => setState(() => _review = true)),
            PxButton.text(
              working ? '叫停并收工' : '不收，直接收工',
              tone: PxTone.danger,
              onPressed: () async {
                await deskRun(() => ref.read(deskApiProvider).farm.dismiss(id: helper.id));
                done();
              },
            ),
            PxButton.text('算了', onPressed: done),
          ],
        ),
      ],
    );
  }
}

class _ReopenForm extends StatefulWidget {
  const _ReopenForm({required this.issue});
  final Issue issue;

  @override
  State<_ReopenForm> createState() => _ReopenFormState();
}

class _ReopenFormState extends State<_ReopenForm> {
  String _text = '';

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('「${ticketTitle(widget.issue)}」由同一个帮工档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。', style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625)),
      const SizedBox(height: 12),
      PxTextArea(
        value: _text,
        onChanged: (v) => setState(() => _text = v),
        rows: 3,
        autofocus: true,
        placeholder: '这次要它做什么（不填就是接着做完）',
        semanticLabel: '这次要做什么',
      ),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          PxButton.text('算了', onPressed: () => Navigator.of(context).pop()),
          const SizedBox(width: 8),
          PxButton.text('重开', tone: PxTone.primary, onPressed: () => Navigator.of(context).pop(_text.trim())),
        ],
      ),
    ],
  );
}

class _Todo extends ConsumerStatefulWidget {
  const _Todo({super.key, required this.item, this.project, required this.reload, required this.onDone});
  final Issue? item;

  final String? project;
  final Future<void> Function() reload;
  final ValueChanged<String?> onDone;

  @override
  ConsumerState<_Todo> createState() => _TodoState();
}

class _TodoState extends ConsumerState<_Todo> {
  late String _title = widget.item?.title ?? '';
  late String _description = widget.item?.description ?? '';
  late String _project = widget.item?.project ?? widget.project ?? '';
  late String _agent = widget.item?.agent ?? '';
  late Priority _priority = widget.item?.priority ?? Priority.normal;
  bool _busy = false;

  Future<void> _newProject(BuildContext context) async {
    final before = {...?ref.read(projectNamesProvider).value};
    await showNewProjectDialog(context);
    ref.invalidate(projectNamesProvider);
    final after = await ref.read(projectNamesProvider.future);
    final made = after.where((p) => !before.contains(p)).firstOrNull;
    if (made != null && mounted) setState(() => _project = made);
  }

  IssueRequest get _request => IssueRequest(
    title: _title,
    description: _description,
    project: _project.isEmpty ? null : _project,
    agent: _agent.isEmpty ? null : _agent,
    priority: _priority,
  );

  Future<void> _run(Future<void> Function(FarmApi farm) act) async {
    setState(() => _busy = true);
    await deskRun(() => act(ref.read(deskApiProvider).farm));
    await widget.reload();
    if (mounted) setState(() => _busy = false);
  }

  @override
  void initState() {
    super.initState();
    if (widget.item == null) {
      unawaited(
        lastPick().then((pick) {
          if (!mounted) return;
          setState(() {
            if (_agent.isEmpty) _agent = pick.$1;
            if (_project.isEmpty) _project = pick.$2;
          });
        }),
      );
    }
  }

  Future<void> _save() => _run((farm) async {
    unawaited(rememberPick(_agent, _project));
    final item = widget.item;
    final saved = item == null ? await farm.addIssue(body: _request) : await farm.editIssue(id: item.id, body: _request);
    if (item == null) widget.onDone(saved.id);
  });

  Future<void> _start() => _run((farm) async {
    unawaited(rememberPick(_agent, _project));
    final item = widget.item ?? await farm.addIssue(body: _request);
    if (widget.item != null) await farm.editIssue(id: item.id, body: _request);
    final got = await farm.startIssue(id: item.id);
    dispatchedNotice(got, item.id, widget.onDone);
    // Waiting for a bed: a new one stays open, now as the 待办 it is.
    if (got.helper == null && widget.item == null) widget.onDone(item.id);
  });

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(projectNamesProvider).value ?? const <String>[];
    final agents = (ref.watch(_agentsProvider).value ?? const <AgentProfile>[]).where((a) => a.enabled).toList();
    final runtimes = ref.watch(runtimesProvider).value ?? const <RuntimeInfo>[];
    final ready = !_busy && _title.trim().isNotEmpty;
    final queued = widget.item?.queuedAt;
    return PxCard(
      title: widget.item == null ? '写一张工单' : '待办',
      aside: widget.item == null ? null : Text('写于 ${wallClockText(widget.item!.createdAt)}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          PxField(
            label: '标题',
            child: PxTextInput(
              value: _title,
              onChanged: (v) => setState(() => _title = v),
              autofocus: widget.item == null,
              placeholder: '比如：给登录页加上记住我',
              semanticLabel: '标题',
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '说明',
            child: PxTextArea(
              value: _description,
              onChanged: (v) => setState(() => _description = v),
              rows: 5,
              placeholder: '做到什么程度算完、要注意什么（可以不写）',
              semanticLabel: '说明',
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '优先级',
            child: PxSegmented<Priority>(
              value: _priority,
              options: [for (final p in Priority.values) SegmentOption(value: p, label: priorityLabel[p]!)],
              onChanged: (v) => setState(() => _priority = v),
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '项目',
            hint: projects.isEmpty ? DeskLink('工作目录里还没有项目：新建一个', onTap: () => _newProject(context)) : DeskLink('＋ 新建项目', onTap: () => _newProject(context)),
            child: PxPick(
              value: _project,
              placeholder: '在哪个项目里做',
              semanticLabel: '项目',
              options: [
                for (final p in {...projects, if (_project.isNotEmpty) _project}) PickOption(value: p, label: p),
              ],
              onChanged: (v) => setState(() => _project = v),
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '帮工',
            child: PxPick(
              value: _agent,
              placeholder: '派哪个帮工档案',
              semanticLabel: '帮工',
              options: [
                for (final a in agents)
                  PickOption(
                    value: a.id,
                    label: a.name,
                    detail: switch (agentIssues(
                      a,
                      runtimes.where((r) => r.id == a.runtime).firstOrNull,
                    ).where((i) => i.level == IssueLevel.error).firstOrNull) {
                      final issue? => '派不出去：${issue.text}',
                      null => a.runtime,
                    },
                  ),
              ],
              onChanged: (v) => setState(() => _agent = v),
            ),
          ),
          if (queued != null) ...[
            const SizedBox(height: 16),
            Container(
              color: Palette.water.withValues(alpha: .15),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '排队中：${ago(queued, DateTime.now().millisecondsSinceEpoch)}排上的，有空地就按看板上的先后自动开工。',
                      style: KitText.sm.copyWith(color: Palette.bark800, height: 1.5),
                    ),
                  ),
                  const SizedBox(width: 8),
                  PxButton.text(
                    '不排了',
                    size: PxSize.sm,
                    onPressed: _busy ? null : () => _run((farm) => farm.queueIssue(id: widget.item!.id, body: const QueueIssueRequest(queued: false))),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              PxButton.text(queued != null ? '现在就试' : '开工', tone: PxTone.primary, onPressed: ready && _agent.isNotEmpty ? _start : null),
              PxButton.text(widget.item == null ? '先存着' : '存下改动', onPressed: ready ? _save : null),
              if (widget.item case final item?)
                PxButton.text(
                  '删掉',
                  tone: PxTone.danger,
                  onPressed: _busy
                      ? null
                      : () => _run((farm) async {
                          await farm.removeIssue(id: item.id);
                          widget.onDone(null);
                        }),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Ticket extends ConsumerStatefulWidget {
  const _Ticket({super.key, required this.issue, required this.runs, required this.state, required this.helper, required this.reload});
  final Issue issue;

  final List<TrajectoryHead> runs;
  final TicketState state;
  final Helper? helper;
  final Future<void> Function() reload;

  @override
  ConsumerState<_Ticket> createState() => _TicketState();
}

class _TicketState extends ConsumerState<_Ticket> {
  String _word = '';
  bool _busy = false;

  Future<Changes?>? _changes;

  @override
  void initState() {
    super.initState();
    unawaited(deskRun(() => ref.read(workStepsProvider.notifier).load(widget.runs.last.id)));
    _askChanges(first: true);
  }

  @override
  void didUpdateWidget(_Ticket old) {
    super.didUpdateWidget(old);
    if (old.state != widget.state) _askChanges();
  }

  /// `first` from initState, before any build.
  void _askChanges({bool first = false}) {
    if (widget.state != TicketState.waiting || widget.helper == null) return;
    final asked = ref.read(deskApiProvider).farm.changes(id: widget.runs.last.id).then<Changes?>((c) => c, onError: (Object _) => null);
    if (first) {
      _changes = asked;
    } else {
      setState(() {
        _changes = asked;
      });
    }
  }

  FarmApi get _farm => ref.read(deskApiProvider).farm;

  Future<void> _act(Future<void> Function() act) async {
    setState(() => _busy = true);
    await deskRun(act);
    await widget.reload();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _tell() async {
    final helper = widget.helper;
    final text = _word.trim();
    if (helper == null || text.isEmpty) return;
    setState(() => _busy = true);
    final done = await deskRun(() async {
      await ref.read(farmCommandsProvider).water(helper, text);
      return true;
    });
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (done == true) _word = '';
    });
  }

  Future<void> _reopen() async {
    setState(() => _busy = true);
    final got = await deskRun(
      () => _farm.reopen(
        id: widget.issue.id,
        body: ReopenRequest(text: _word.trim()),
      ),
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (got?.helper case final helper?) {
      toasts.add(type: ToastType.info, title: '工单重开了', description: '$helper 接着做。');
      await widget.reload();
    }
  }

  Future<void> _close(Helper helper) async {
    await showFarmDialog<void>(
      context,
      title: Text('关上「${ticketTitle(widget.issue)}」'),
      size: FarmDialogSize.lg,
      icon: 'icon-harvest',
      builder: (_) => _CloseTicket(helper: helper),
    );
    await widget.reload();
  }

  void _toBed(Helper helper) {
    ref.read(titleOpenProvider.notifier).enterFarm(start: false);
    ref.read(selectedProvider.notifier).set(helper.id);
    deskGo(context, '/');
  }

  /// A playbook's step has none of its own: it goes with its playbook.
  List<Widget> _actions(Helper? helper) {
    final busy = _busy;
    final bed = helper == null ? null : PxButton.text('去农场看这块地', icon: 'button-open', size: PxSize.sm, onPressed: () => _toBed(helper));
    if (ticketPlanned(widget.issue, helper)) return [?bed];
    return switch ((widget.state, helper)) {
      (TicketState.working, final h?) => [
        PxButton.text(
          '叫停这一轮',
          size: PxSize.sm,
          onPressed: busy ? null : () => _act(() => _farm.stop(id: h.id)),
        ),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (TicketState.waiting, final h?) when h.conflict != null => [
        PxButton.text(
          '让它解决冲突',
          size: PxSize.sm,
          tone: PxTone.primary,
          onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).water(h, conflictTask(h.conflict!.base, h.conflict!.files))),
        ),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
      (TicketState.waiting, final h?) when h.last?.outcome == Outcome.interrupted => [
        PxButton.text(
          '接着做',
          size: PxSize.sm,
          tone: PxTone.primary,
          onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).water(h, '上一轮停在了半路，接着把它做完。')),
        ),
        PxButton.text('收获', size: PxSize.sm, onPressed: busy ? null : () => _close(h)),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (TicketState.waiting, final h?) => [
        if (h.last?.outcome != Outcome.failed) PxButton.text('收获', size: PxSize.sm, tone: PxTone.primary, onPressed: busy ? null : () => _close(h)),
        if (h.last?.outcome == Outcome.failed)
          PxButton.text('接着修', size: PxSize.sm, tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).cure(h))),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      _ => const [],
    };
  }

  @override
  Widget build(BuildContext context) {
    final issue = widget.issue;
    final runs = widget.runs;
    final head = runs.last;
    final helper = widget.helper;
    final open = widget.state.open;
    final steps = ref.watch(workStepsProvider.select((all) => all[head.id])) ?? const <WorkStep>[];
    final body = KitText.sm.copyWith(color: Palette.bark800);
    final turns = helper?.turns ?? head.turns;
    final cny = helper?.spent?.cny ?? head.cny;
    final summary = helper?.last?.summary ?? head.summary;
    final actions = _actions(helper);
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        PxCard(
          title: ticketTitle(issue, ref.watch(plansProvider)),
          aside: Text(widget.state.label),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (actions.isNotEmpty) ...[Wrap(spacing: 8, runSpacing: 8, children: actions), const SizedBox(height: 12)],
              _Row('谁在做', Text('${head.name}${head.runtime != null ? '（${head.runtime}）' : ''}', style: body)),
              if (issue.project != null) _Row('项目', Text(issue.project!, style: body)),
              if (helper?.branch != null) _Row('分支', Text(helper!.branch!, style: KitText.mono.copyWith(color: Palette.bark800))),
              _Row('开单', Text(wallClockText(issue.createdAt), style: body)),
              if (issue.closedAt != null) _Row('关单', Text(wallClockText(issue.closedAt!), style: body)),
              if (runs.length > 1) _Row('做过', Text('${runs.length} 次：${runs.map((r) => '${r.name}（${r.id}）').join(' → ')}', style: body.copyWith(height: 1.5))),
              _Row(
                '用时',
                Text(
                  [
                    '${turns?.round() ?? roundsOf(steps).length} 轮',
                    tookText((head.endedAt ?? now) - head.startedAt),
                    if (cny != null) '花了 ¥${cny.toStringAsFixed(2)}',
                  ].join(' · '),
                  style: body,
                ),
              ),
              if (summary != null && summary.isNotEmpty) _Row('最后一轮', Text(summary, style: body)),
              if (ticketPlanned(issue, helper))
                _Row(
                  '种植计划',
                  Text(
                    helper?.playbook != null ? '这是计划 ${helper!.playbook!.id} 里的一步：做完自动合进计划分支，收获整个计划时再进主分支。在农场的「计划」里管它。' : '这是种植计划里的一步，已经合进了计划分支，跟着计划走。',
                    style: body,
                  ),
                ),
              if (helper?.conflict case final conflict?)
                _Row('冲突', Text('合进 ${conflict.base} 会冲突：${conflict.files.join('、')}', style: body.copyWith(color: Palette.berry))),
            ],
          ),
        ),
        if (_changes != null) ...[
          const SizedBox(height: 12),
          FutureBuilder<Changes?>(
            future: _changes,
            builder: (context, snap) {
              final c = snap.data;
              if (c == null) {
                return PxCard(
                  title: '改动',
                  child: Text(snap.connectionState == ConnectionState.done ? '读不到改动。' : '在读……', style: body),
                );
              }
              final added = c.files.fold<double>(0, (n, f) => n + f.added).round();
              final removed = c.files.fold<double>(0, (n, f) => n + f.removed).round();
              return PxCard(
                title: '改动',
                aside: Text('${c.branch ?? ''} → ${c.base}'),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '${c.commits.length} 个提交 · ${c.files.length} 个文件 · +$added -$removed${c.uncommitted.isNotEmpty ? ' · ${c.uncommitted.length} 个没提交' : ''}',
                      style: body,
                    ),
                    if (c.conflicts.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text('合进 ${c.base} 会冲突：${c.conflicts.join('、')}', style: body.copyWith(color: Palette.berry)),
                    ],
                    const SizedBox(height: 6),
                    for (final f in c.files.take(8))
                      Text(
                        '${f.path}  +${f.added.round()} -${f.removed.round()}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: KitText.mono.copyWith(fontSize: 11, color: Palette.bark800),
                      ),
                    if (c.files.length > 8) Text('还有 ${c.files.length - 8} 个文件', style: KitText.xs.copyWith(color: Palette.bark500)),
                  ],
                ),
              );
            },
          ),
        ],
        const SizedBox(height: 12),
        PxCard(
          title: '干活过程',
          child: steps.isEmpty
              ? DeskEmpty(head.endedAt == null ? '还没有步骤。' : '干活过程只留 30 天（VIBEVALLEY_TRAJECTORY_DAYS），这张工单的已经清掉了；它是谁做的、怎么关的还在上面。')
              : Ticking(
                  builder: (context, now) => WorkLog(
                    steps: steps,
                    now: now,
                    tall: true,
                    working: widget.state == TicketState.working,
                    onComment: open && helper != null ? (step, text) => ref.read(farmCommandsProvider).water(helper, text, on: step) : null,
                  ),
                ),
        ),
        const SizedBox(height: 12),
        if (open && helper != null)
          PxCard(
            title: '带话',
            child: Row(
              children: [
                Expanded(
                  child: PxTextInput(
                    value: _word,
                    onChanged: (v) => setState(() => _word = v),
                    onSubmitted: (_) => _tell(),
                    enabled: !_busy,
                    placeholder: helper.phase is PhaseWorking ? '干着活也能收到这句话' : '说一句，它接着做一轮',
                    semanticLabel: '给${helper.name}带句话',
                  ),
                ),
                const SizedBox(width: 8),
                PxButton.text('带话', tone: PxTone.primary, onPressed: _busy || _word.trim().isEmpty ? null : _tell),
              ],
            ),
          )
        else if (!open && !ticketPlanned(issue, helper))
          PxCard(
            title: '重开',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('派同一个帮工档案的新帮工，在同一个项目里接着做这张工单。它会知道原来要做什么、上一次是怎么关的、最后一轮说了什么。', style: body.copyWith(height: 1.625)),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: PxTextInput(
                        value: _word,
                        onChanged: (v) => setState(() => _word = v),
                        onSubmitted: (_) => _reopen(),
                        enabled: !_busy,
                        placeholder: '这次要它做什么（不填就是接着做完）',
                        semanticLabel: '重开这张工单',
                      ),
                    ),
                    const SizedBox(width: 8),
                    PxButton.text('重开', tone: PxTone.primary, onPressed: _busy ? null : _reopen),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.child);
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: KitText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}
