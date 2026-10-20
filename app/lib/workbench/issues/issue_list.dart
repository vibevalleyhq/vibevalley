import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../data/remote.dart';
import '../../gen/vibevalley.dart';
import '../../rules/board.dart';
import '../../rules/issues.dart';
import '../../shared/chat_widgets.dart' show ManagerHead;
import '../../shared/faces.dart';
import '../../ui/pro/pro.dart';
import '../shared/widgets.dart';
import 'board.dart';
import 'card_look.dart';
import 'issues_page.dart';
import 'marks.dart';

typedef ListAdd = Future<void> Function(String text, {String project, String agent});

/// The issues as rows, grouped as the owner picked: Linear's list. A row opens the issue as a card does.
class IssueList extends ConsumerStatefulWidget {
  const IssueList({
    super.key,
    required this.cards,
    required this.loading,
    required this.selected,
    required this.older,
    required this.grouping,
    required this.ordering,
    required this.onOlder,
    required this.onOpen,
    required this.onAdd,
  });
  final List<BoardCard> cards;
  final bool loading;
  final String? selected;
  final bool older;
  final Grouping grouping;
  final Ordering ordering;
  final VoidCallback onOlder;
  final ValueChanged<String?> onOpen;

  /// The quick add, with the group's project or helper when grouped by one.
  final ListAdd onAdd;

  @override
  ConsumerState<IssueList> createState() => _IssueListState();
}

class _IssueListState extends ConsumerState<IssueList> {
  final _folded = <String>{};
  String? _adding;

  /// Only where a new 待办 belongs: the 待办 group, a project's, a helper's (not the manager's), or the one group.
  bool _canAdd(RowGroup<BoardCard> g) => switch (widget.grouping) {
    Grouping.status => g.lane == Lane.todo,
    Grouping.project => true,
    Grouping.agent => g.key != managerAgent,
    Grouping.none => true,
  };

  Future<void> _add(RowGroup<BoardCard> g, String text) {
    setState(() => _adding = null);
    return switch (widget.grouping) {
      Grouping.project => widget.onAdd(text, project: g.key),
      Grouping.agent => widget.onAdd(text, agent: g.key),
      Grouping.status || Grouping.none => widget.onAdd(text),
    };
  }

  @override
  Widget build(BuildContext context) {
    if (widget.loading) return const Padding(padding: EdgeInsets.all(12), child: EmptyNote('在读……'));
    final agents = ref.watch(workbenchConfigProvider).agents;
    String nameOf(String id) => id == managerAgent ? '管家' : agents.where((a) => a.id == id).firstOrNull?.name ?? id;
    final graphs = ref.watch(graphsProvider);
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final groups = groupRows(widget.cards, widget.grouping, rowFacts);
    final items = <Widget>[];
    for (final g in groups) {
      var rows = g.lane != null ? laneOrder(g.lane!, g.rows, widget.ordering) : orderRows(g.rows, widget.ordering, rowFacts);
      var hidden = 0;
      if (g.lane == Lane.closed && !widget.older && rows.length > closedShown) {
        hidden = rows.length - closedShown;
        rows = rows.take(closedShown).toList();
      }
      final folded = _folded.contains(g.key);
      final (label, Widget? icon) = switch (widget.grouping) {
        Grouping.status => (g.lane!.label, StatusMark(laneStatus(g.lane!))),
        Grouping.project => (g.key.isEmpty ? '没有项目' : g.key, const SpriteIcon('button-folder', size: 14)),
        Grouping.agent => (
          g.key.isEmpty ? '还没选帮工' : nameOf(g.key),
          g.key.isEmpty
              ? const NoFaceMark(size: 14)
              : g.key == managerAgent
              ? const ManagerHead(size: 16)
              : AgentFaceOf(g.key, size: 16),
        ),
        Grouping.none => ('全部工单', null),
      };
      items.add(
        _GroupHeader(
          key: ValueKey('group:${g.key}'),
          label: label,
          icon: icon,
          count: g.rows.length,
          folded: folded,
          onFold: () => setState(() => folded ? _folded.remove(g.key) : _folded.add(g.key)),
          onAdd: _canAdd(g) ? () => setState(() => _adding = _adding == g.key ? null : g.key) : null,
        ),
      );
      if (folded) continue;
      if (_adding == g.key) {
        items.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
            child: QuickAdd(autofocus: true, onAdd: (text) => _add(g, text)),
          ),
        );
      }
      for (final card in rows) {
        items.add(
          _Row(
            key: ValueKey(card.id),
            card: card,
            look: cardLook(card, nameOf: nameOf, graphs: graphs, now: now),
            updated: rowFacts(card).updatedAt,
            now: now,
            showProject: widget.grouping != Grouping.project,
            selected: card.id == widget.selected,
            onOpen: widget.onOpen,
          ),
        );
      }
      if (hidden > 0 || (g.lane == Lane.closed && widget.older && g.rows.length > closedShown)) items.add(OlderLink(hidden: hidden, onTap: widget.onOlder));
      if (g.rows.isEmpty && _adding != g.key) {
        items.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(36, 6, 12, 10),
            child: Text('没有工单', style: ProText.meta.copyWith(color: ProColor.faint)),
          ),
        );
      }
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: ListView(children: items),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({super.key, required this.label, required this.icon, required this.count, required this.folded, required this.onFold, this.onAdd});
  final String label;
  final Widget? icon;
  final int count;
  final bool folded;
  final VoidCallback onFold;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 6, bottom: 2),
    child: Container(
      height: 34,
      decoration: const BoxDecoration(color: ProColor.hover, borderRadius: proRadius),
      child: Row(
        children: [
          Expanded(
            child: Tappable(
              onTap: onFold,
              semanticLabel: folded ? '展开 $label' : '收起 $label',
              builder: (context, s) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Row(
                  children: [
                    RotatedBox(quarterTurns: folded ? 0 : 1, child: const SpriteIcon('button-next', size: 10)),
                    const SizedBox(width: 10),
                    if (icon != null) ...[icon!, const SizedBox(width: 8)],
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ProText.sm.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text('$count', style: ProText.meta),
                  ],
                ),
              ),
            ),
          ),
          if (onAdd != null) ProButton.icon('button-add', tooltip: '写一张', semanticLabel: '在「$label」写一张', iconSize: 14, onPressed: onAdd),
          const SizedBox(width: 4),
        ],
      ),
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    super.key,
    required this.card,
    required this.look,
    required this.updated,
    required this.now,
    required this.showProject,
    required this.selected,
    required this.onOpen,
  });
  final BoardCard card;
  final CardLook look;
  final double updated;
  final double now;
  final bool showProject;
  final bool selected;
  final ValueChanged<String?> onOpen;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final wide = box.maxWidth >= 640;
      final face = cardFace(card, size: 18);
      return Tappable(
        onTap: () => onOpen(card.id),
        tooltip: cardTip(look),
        semanticLabel: look.title,
        selected: selected,
        builder: (context, s) => Container(
          height: 38,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: selected
                ? ProColor.selected
                : s.hovered
                ? ProColor.hover
                : null,
            borderRadius: proRadius,
          ),
          child: Row(
            children: [
              SizedBox(width: 14, child: look.priority == null ? null : PriorityMark(look.priority!, size: 13)),
              const SizedBox(width: 10),
              if (wide) SizedBox(width: 44, child: Text(look.number ?? '', maxLines: 1, style: ProText.meta)),
              StatusMark(look.status, color: look.statusColor, size: 13),
              const SizedBox(width: 10),
              Expanded(
                child: Text(look.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.sm),
              ),
              if (look.progress case final p?) ...[const SizedBox(width: 8), ProgressMark(done: p.done, total: p.total)],
              for (final chip in wide ? flagChips(look) : flagChips(look).take(1)) ...[const SizedBox(width: 6), chip],
              if (wide && showProject && card.project != null) ...[
                const SizedBox(width: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 120),
                  child: Text(card.project!, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
                ),
              ],
              const SizedBox(width: 10),
              SizedBox(width: 18, child: face),
              const SizedBox(width: 10),
              SizedBox(
                width: wide ? 72 : 56,
                child: Text(ago(updated, now), maxLines: 1, textAlign: TextAlign.right, style: ProText.meta),
              ),
            ],
          ),
        ),
      );
    },
  );
}
