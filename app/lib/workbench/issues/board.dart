import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/board.dart';
import '../../rules/issues.dart';
import '../../ui/pro/pro.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import 'card_look.dart';
import 'issues_page.dart';
import 'marks.dart';

Move? cardMove(BoardCard card, Lane to) => switch (card) {
  TaskCard() || ManagerCard() || MissingSessionCard() => null,
  TodoCard(:final item) => moveOf(card.lane, to, item.moves),
  IssueCard(:final issue) => moveOf(card.lane, to, issue.moves),
};

/// A lane's cards in the order the owner picked; the closed lane by default newest closed first.
List<BoardCard> laneOrder(Lane lane, List<BoardCard> cards, Ordering ordering) {
  if (lane == Lane.closed && ordering == Ordering.manual) return [...cards]..sort((a, b) => _closedAt(b).compareTo(_closedAt(a)));
  return orderRows(cards, ordering, rowFacts);
}

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
    required this.onWrite,
    this.ordering = Ordering.manual,
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

  /// The pencil: an empty draft made at once and opened.
  final VoidCallback onWrite;

  /// Anything but manual hides the owner's order of 待办, so a card cannot be dropped between two there.
  final Ordering ordering;

  @override
  State<IssueBoard> createState() => _BoardState();
}

const _oneLane = 700.0;

class _BoardState extends State<IssueBoard> {
  Lane _lane = Lane.todo;
  final _addFocus = FocusNode();

  @override
  void dispose() {
    _addFocus.dispose();
    super.dispose();
  }

  Widget _laneView(Lane lane) => _LaneView(
    lane: lane,
    cards: [
      for (final c in widget.cards)
        if (c.lane == lane) c,
    ],
    loading: widget.loading,
    selected: widget.selected,
    older: widget.older,
    ordering: widget.ordering,
    addFocus: _addFocus,
    onOlder: widget.onOlder,
    onOpen: widget.onOpen,
    onDrop: widget.onDrop,
    onPlace: widget.onPlace,
    onAdd: widget.onAdd,
    onWrite: widget.onWrite,
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
      const least = 220.0;
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
    required this.ordering,
    required this.addFocus,
    required this.onOlder,
    required this.onOpen,
    required this.onDrop,
    required this.onPlace,
    required this.onAdd,
    required this.onWrite,
  });
  final Lane lane;
  final List<BoardCard> cards;
  final bool loading;
  final String? selected;
  final bool older;
  final Ordering ordering;
  final FocusNode addFocus;
  final VoidCallback onOlder;
  final ValueChanged<String?> onOpen;
  final Future<void> Function(BoardCard card, Lane to) onDrop;
  final Future<void> Function(TodoCard card, String? before) onPlace;
  final Future<void> Function(String text) onAdd;

  /// The pencil: an empty draft made at once and opened.
  final VoidCallback onWrite;

  @override
  Widget build(BuildContext context) {
    var shown = laneOrder(lane, cards, ordering);
    var hidden = 0;
    if (lane == Lane.closed && !older && shown.length > closedShown) {
      hidden = shown.length - closedShown;
      shown = shown.take(closedShown).toList();
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
                  StatusMark(laneStatus(lane)),
                  const SizedBox(width: 8),
                  Text(lane.label, style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Text(head, style: ProText.meta),
                  const Spacer(),
                  if (lane == Lane.todo) ...[
                    ProButton.icon('button-add', tooltip: '写一张', semanticLabel: '写一张', iconSize: 14, onPressed: addFocus.requestFocus),
                    ProButton.icon('button-edit', tooltip: '详细写一张', semanticLabel: '详细写一张', iconSize: 14, onPressed: onWrite),
                  ],
                ],
              ),
            ),
            if (lane == Lane.todo) ...[const SizedBox(height: 6), QuickAdd(onAdd: onAdd, focusNode: addFocus)],
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
                      separatorBuilder: (_, _) => const SizedBox(height: 6),
                      itemBuilder: (context, i) {
                        if (i == shown.length) return OlderLink(hidden: hidden, onTap: onOlder);
                        final card = shown[i];
                        final view = _CardView(card: card, selected: card.id == selected, onOpen: onOpen);
                        return card is TodoCard && ordering == Ordering.manual ? _PlaceBefore(card: card, onPlace: onPlace, child: view) : view;
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Under the closed ones: how many older are folded away, or back to the recent ones.
class OlderLink extends StatelessWidget {
  const OlderLink({super.key, required this.hidden, required this.onTap});
  final int hidden;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Center(
      child: DefaultTextStyle(
        style: ProText.sm,
        child: InlineLink(hidden > 0 ? '更早的 $hidden 张' : '只看最近的', onTap: onTap),
      ),
    ),
  );
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

/// One sentence, enter, and it is a 待办: the board's lane and the list's groups both use it.
class QuickAdd extends StatefulWidget {
  const QuickAdd({super.key, required this.onAdd, this.focusNode, this.autofocus = false});
  final Future<void> Function(String text) onAdd;
  final FocusNode? focusNode;
  final bool autofocus;

  @override
  State<QuickAdd> createState() => _QuickAddState();
}

class _QuickAddState extends State<QuickAdd> {
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
    focusNode: widget.focusNode,
    autofocus: widget.autofocus,
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
    final look = cardLook(
      card,
      nameOf: (id) => agents.where((a) => a.id == id).firstOrNull?.name ?? id,
      graphs: ref.watch(graphsProvider),
      now: DateTime.now().millisecondsSinceEpoch.toDouble(),
    );
    final face = cardFace(card);
    final where = [?look.number, ?card.project].join(' · ');
    Widget body(double opacity, {bool hovered = false}) => Opacity(
      opacity: opacity,
      child: Container(
        decoration: BoxDecoration(
          color: Color.alphaBlend(
            selected
                ? ProColor.selected
                : hovered
                ? ProColor.hover
                : const Color(0x00000000),
            ProColor.page,
          ),
          border: Border.all(color: hovered && !selected ? ProColor.ink.withValues(alpha: .18) : ProColor.line),
          borderRadius: const BorderRadius.all(Radius.circular(8)),
        ),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (where.isNotEmpty)
              Text(
                where,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ProText.meta.copyWith(fontSize: 11, height: 14 / 11),
              ),
            const SizedBox(height: 3),
            Text(
              look.title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
            ),
            const SizedBox(height: 7),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                StatusMark(look.status, color: look.statusColor, size: 13),
                if (look.priority case final p?) PriorityMark(p, size: 13),
                ?face,
                if (look.progress case final p?) ProgressMark(done: p.done, total: p.total),
                ...flagChips(look),
              ],
            ),
          ],
        ),
      ),
    );
    final tappable = Tappable(
      onTap: () => onOpen(card.id),
      tooltip: cardTip(look),
      semanticLabel: look.title,
      selected: selected,
      builder: (context, s) => body(1, hovered: s.hovered),
    );
    if (card is TaskCard) return tappable;
    final feedback = Material(
      type: MaterialType.transparency,
      child: SizedBox(width: 240, child: body(.9)),
    );
    // A phone scrolls the lane with a drag: a card is picked up with a long press there.
    return Platform.isIOS || Platform.isAndroid
        ? LongPressDraggable<BoardCard>(data: card, feedback: feedback, childWhenDragging: body(.35), child: tappable)
        : Draggable<BoardCard>(data: card, feedback: feedback, childWhenDragging: body(.35), child: tappable);
  }
}

double _closedAt(BoardCard c) => switch (c) {
  IssueCard(:final issue, :final head) => issue.closedAt ?? head.hiredAt,
  ManagerCard(:final issue) || MissingSessionCard(:final issue) => issue.closedAt ?? issue.createdAt,
  TodoCard(:final item) => item.closedAt ?? item.createdAt,
  TaskCard() => 0,
};
