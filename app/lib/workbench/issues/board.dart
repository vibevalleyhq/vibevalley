import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/rounds.dart' show tookText;
import '../../rules/issues.dart';
import '../../data/ui_state.dart' show FarmPanel, graphShownProvider, titleOpenProvider, farmOverlaysProvider;
import '../../ui/pro/pro.dart';
import '../shared/layout.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../../shared/faces.dart';
import 'issues_page.dart';

Move? cardMove(BoardCard card, Lane to) => switch (card) {
  TaskCard() || ManagerCard() || MissingSessionCard() => null,
  TodoCard(:final item) => moveOf(card.lane, to, item.moves),
  IssueCard(:final issue) => moveOf(card.lane, to, issue.moves),
};

class IssueBoard extends StatefulWidget {
  const IssueBoard({
    super.key,
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
  State<IssueBoard> createState() => _BoardState();
}

const _oneLane = 700.0;

class _BoardState extends State<IssueBoard> {
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
              ProSegmented<Lane>(
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
      shown = [...cards]..sort((a, b) => _closedAt(b).compareTo(_closedAt(a)));
      if (!older && shown.length > closedShown) {
        hidden = shown.length - closedShown;
        shown = shown.take(closedShown).toList();
      }
    }
    final head = switch (lane) {
      Lane.working => '${cards.whereType<IssueCard>().length} / $maxRunning 块地',
      _ => '${cards.length}',
    };
    return DragTarget<BoardCard>(
      onWillAcceptWithDetails: (d) => cardMove(d.data, lane) != null || (lane == Lane.todo && d.data is TodoCard),
      onAcceptWithDetails: (d) => unawaited(onDrop(d.data, lane)),
      builder: (context, coming, refused) => Container(
        decoration: BoxDecoration(
          color: coming.isNotEmpty ? Palette.leaf300.withValues(alpha: .25) : ProColor.hover,
          border: Border.all(color: coming.isNotEmpty ? Palette.leaf600 : const Color(0x00000000)),
          borderRadius: const BorderRadius.all(Radius.circular(10)),
        ),
        padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 28,
              child: Row(
                children: [
                  const SizedBox(width: 4),
                  Text(lane.label, style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Text(head, style: ProText.meta),
                  const Spacer(),
                  if (lane == Lane.todo) ProButton.icon('button-edit', tooltip: '详细写一张', semanticLabel: '详细写一张', iconSize: 14, onPressed: () => onOpen('new')),
                ],
              ),
            ),
            if (lane == Lane.todo) ...[const SizedBox(height: 6), _QuickAdd(onAdd: onAdd)],
            const SizedBox(height: 8),
            Expanded(
              child: loading
                  ? const EmptyNote('在读……')
                  : cards.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Text(_emptyText[lane]!, style: ProText.meta.copyWith(color: ProColor.faint, height: 1.5)),
                    )
                  : ListView.separated(
                      itemCount: shown.length + (hidden > 0 || (older && cards.length > closedShown) ? 1 : 0),
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (context, i) {
                        if (i == shown.length) {
                          return Center(
                            child: DefaultTextStyle(
                              style: ProText.sm,
                              child: InlineLink(hidden > 0 ? '更早的 $hidden 张' : '只看最近的', onTap: onOlder),
                            ),
                          );
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
        if (coming.isNotEmpty)
          Container(
            height: 2,
            margin: const EdgeInsets.only(bottom: 4),
            decoration: const BoxDecoration(color: Palette.leaf600, borderRadius: BorderRadius.all(Radius.circular(1))),
          ),
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
  Widget build(BuildContext context) => ProTextInput(
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
    final agents = ref.watch(workbenchConfigProvider).agents;
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    const xs = ProText.meta;
    final (title, who, stripe) = switch (card) {
      TaskCard(:final graph) => ('计划：${graph.title}', '${graph.tasks.length} 步', null),
      TodoCard(:final item) => (item.title, agents.where((a) => a.id == item.assignee).firstOrNull?.name ?? '还没选帮工', priorityColor(item.priority)),
      IssueCard(:final issue, :final head) => (issueTitle(issue, ref.watch(graphsProvider)), head.name, null),
      ManagerCard(:final issue) => (issue.title, '管家', null),
      MissingSessionCard(:final issue) => (issue.title, '执行记录缺失', null),
    };
    final Color? dot = switch (card) {
      IssueCard(:final state) => issueTagColor(state),
      ManagerCard(:final issue) => issueTagColor(issueTag(issue)),
      TaskCard() => Palette.leaf500,
      TodoCard() || MissingSessionCard() => null,
    };
    final tags = <Widget>[];
    final lines = <Widget>[];
    switch (card) {
      case MissingSessionCard(:final history):
        lines.add(Text('缺少：${history.missingSessions.join('、')}', style: xs.copyWith(color: Palette.berry)));
      case TaskCard(:final graph):
        tags.add(const _Tag('种植计划', Palette.leaf500));
        lines.add(Text(taskLine(graph), style: ProText.xs.copyWith(color: graph.state == GraphState.ripe ? Palette.leaf700 : ProColor.ink)));
      case TodoCard(:final item):
        if (item.drafting case final d?) {
          tags.add(_Tag('${d.name}在起草', Palette.water));
        } else if (item.status == IssueStatus.backlog) {
          tags.add(const _Tag('草稿', Palette.wheat));
        }
        if (item.queuedAt != null) tags.add(const _Tag('排队中', Palette.water));
        if (item.schedule != null) tags.add(const _Tag('定时', Palette.cream300));
        if (item.priority == Priority.urgent || item.priority == Priority.high) tags.add(_Tag(priorityLabel[item.priority]!, priorityColor(item.priority)!));
        if (item.assignee == null || item.project == null) tags.add(const _Tag('没选帮工或项目', Palette.cream300));
        lines.add(Text(item.queuedAt != null ? '等空地，${ago(item.queuedAt!, now)}排上的' : '写于 ${ago(item.createdAt, now)}', style: xs));
      case ManagerCard(:final issue):
        if (issue.schedule != null) tags.add(const _Tag('定时', Palette.cream300));
        final state = issueTag(issue);
        lines.add(Text(state.open ? '管家在做' : '${state.label} · ${ago(issue.closedAt ?? issue.createdAt, now)}', style: xs));
      case IssueCard(:final issue, :final sessions, :final head, :final state, :final session):
        final phase = session?.phase;
        if (session?.conflict != null) tags.add(const _Tag('冲突', Palette.berry));
        if (phase is PhaseWorking && phase.quietSince != null) tags.add(_Tag('${tookText(now - phase.quietSince!)}没动静', Palette.wheat));
        if (phase is PhaseFailed || (session ?? head).lastRun?.outcome == Outcome.failed) tags.add(const _Tag('没做成', Palette.berry));
        if (state == IssueTag.lost) tags.add(const _Tag('丢了', Palette.berry));
        if (sessions.length > 1) tags.add(_Tag('第 ${sessions.length} 次', Palette.water));
        if (issue.schedule != null) tags.add(const _Tag('定时', Palette.cream300));
        if (issueInTask(issue, session)) tags.add(const _Tag('种植计划', Palette.leaf500));
        final turns = (session ?? head).runs.round();
        final cny = (session ?? head).spent?.cny;
        final took = state.open ? '开了 ${tookText(now - head.hiredAt)}' : '用了 ${tookText((issue.closedAt ?? head.endedAt ?? now) - sessions.first.hiredAt)}';
        lines.add(
          Text([if (state == IssueTag.working) '第 ${turns + 1} 轮' else '$turns 轮', took, if (cny != null) '¥${cny.toStringAsFixed(2)}'].join(' · '), style: xs),
        );
        final said = (session ?? head).lastRun?.summary;
        if (state == IssueTag.waiting && said != null && said.isNotEmpty) {
          lines.add(
            Text(
              said,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: ProText.xs.copyWith(height: 18 / 12),
            ),
          );
        }
        if (!state.open) lines.add(Text('${state.label} · ${ago(issue.closedAt ?? head.endedAt ?? head.hiredAt, now)}', style: xs));
    }
    Widget face(double opacity, {bool hovered = false}) => Opacity(
      opacity: opacity,
      child: Container(
        decoration: BoxDecoration(
          color: selected ? Color.alphaBlend(ProColor.selected, ProColor.page) : ProColor.page,
          border: Border.all(color: hovered && !selected ? ProColor.ink.withValues(alpha: .22) : ProColor.line),
          borderRadius: const BorderRadius.all(Radius.circular(8)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          children: [
            // The priority shows as a stripe down the card's left edge.
            if (stripe != null) Positioned(left: 0, top: 0, bottom: 0, child: Container(width: 3, color: stripe)),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (dot != null) ...[Padding(padding: const EdgeInsets.only(top: 6), child: StateDot(dot)), const SizedBox(width: 8)],
                      Expanded(
                        child: Text(
                          title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
                        ),
                      ),
                    ],
                  ),
                  if (tags.isNotEmpty) ...[const SizedBox(height: 6), Wrap(spacing: 4, runSpacing: 4, children: tags)],
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      if (card.agent != null) ...[AgentFaceOf(card.agent!, size: 18), const SizedBox(width: 6)],
                      Flexible(
                        child: Text(who, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.xs),
                      ),
                      if (card.project != null) ...[
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            card.project!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ProText.mono.copyWith(fontSize: 11, color: ProColor.muted),
                          ),
                        ),
                      ],
                    ],
                  ),
                  for (final line in lines) ...[const SizedBox(height: 4), line],
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (card case TaskCard(:final graph)) {
      return Tappable(
        onTap: () {
          ref.read(graphShownProvider.notifier).set(graph.id);
          ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.taskBoard);
          ref.read(titleOpenProvider.notifier).enterFarm(start: false);
          workbenchGo(context, '/');
        },
        semanticLabel: title,
        builder: (context, s) => face(1, hovered: s.hovered),
      );
    }
    final tappable = Tappable(
      onTap: () => onOpen(card.id),
      semanticLabel: title,
      builder: (context, s) => face(1, hovered: s.hovered),
    );
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
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(color: color.withValues(alpha: .2), borderRadius: const BorderRadius.all(Radius.circular(4))),
    child: Text(
      text,
      style: ProText.xs.copyWith(fontSize: 11, height: 16 / 11, fontWeight: FontWeight.w500),
    ),
  );
}

double _closedAt(BoardCard c) => switch (c) {
  IssueCard(:final issue, :final head) => issue.closedAt ?? head.hiredAt,
  ManagerCard(:final issue) || MissingSessionCard(:final issue) => issue.closedAt ?? issue.createdAt,
  TodoCard(:final item) => item.closedAt ?? item.createdAt,
  TaskCard() => 0,
};
