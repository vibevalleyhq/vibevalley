import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../ui/kit/kit.dart';

const wideFrom = 1024.0;

/// From this width a workbench page shows its list and the one open beside it, below it one at a time (the board, the map).
const sideBySideFrom = 1100.0;

class ListDetail extends StatelessWidget {
  const ListDetail({
    super.key,
    required this.list,
    required this.detail,
    this.listWidth = 288,
    this.detailMaxWidth,
    this.detailScrolls = false,
    this.opened = false,
  });
  final Widget list;

  final List<Widget> detail;
  final double listWidth;

  final double? detailMaxWidth;

  /// A scroll container of its own cuts the outline of the frame at its top; else the frames at its edges show whole.
  final bool detailScrolls;

  /// The route names one item: on a narrow window its detail comes first, or a link to it would land on the list.
  final bool opened;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final gap = box.maxWidth >= 640 ? 12.0 : 8.0;
      final side = EdgeInsets.fromLTRB(gap, 0, gap, 12);
      if (box.maxWidth < wideFrom) {
        return Padding(
          padding: side,
          child: PxScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: _spaced(opened ? [...detail, list] : [list, ...detail])),
          ),
        );
      }
      Widget column = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: _spaced(detail));
      if (detailMaxWidth case final w?) {
        column = Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: w),
            child: column,
          ),
        );
      }
      return Padding(
        padding: side,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: listWidth,
              child: PxScrollView(child: list),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: detailScrolls ? SingleChildScrollView(padding: const EdgeInsets.only(bottom: 6), child: column) : PxScrollView(child: column),
            ),
          ],
        ),
      );
    },
  );
}

List<Widget> _spaced(List<Widget> items) => [
  for (var i = 0; i < items.length; i++) ...[if (i > 0) const SizedBox(height: 12), items[i]],
];

class ListCard extends StatelessWidget {
  const ListCard({super.key, required this.title, this.subtitle, this.note, required this.children, this.semanticLabel});
  final String title;
  final String? subtitle;

  final String? note;
  final List<Widget> children;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    label: semanticLabel,
    child: PxWindow(
      paper: Palette.cream50,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(8, 4, 8, note == null ? 12 : 4),
            child: Text.rich(
              TextSpan(
                text: title,
                children: [
                  if (subtitle != null)
                    TextSpan(
                      text: ' $subtitle',
                      style: KitText.sm.copyWith(color: Palette.bark500),
                    ),
                ],
              ),
              style: KitText.xl,
            ),
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
              child: Text(note!, style: KitText.xs.copyWith(color: Palette.bark500)),
            ),
          ...children,
        ],
      ),
    ),
  );
}

class ListRow extends StatelessWidget {
  const ListRow({super.key, required this.active, required this.onTap, required this.child, this.semanticLabel});
  final bool active;
  final VoidCallback onTap;
  final Widget child;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: KitTappable(
      onTap: onTap,
      selected: active,
      semanticLabel: semanticLabel,
      builder: (context, s) => Container(
        padding: const EdgeInsets.all(8),
        color: active
            ? Palette.leaf300.withValues(alpha: .6)
            : s.hovered
            ? Palette.cream200
            : null,
        // focus-visible:ring-2 (and the shown one's shadow-[inset…]): the skin's inner cream-300 line on every row.
        foregroundDecoration: pxRing,
        child: child,
      ),
    ),
  );
}

class RowText extends StatelessWidget {
  const RowText(this.name, this.line, {super.key, this.extra});
  final String name;
  final String line;
  final Widget? extra;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(name, style: KitText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
      Text(
        line,
        style: KitText.fine.copyWith(color: Palette.bark500),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      ?extra,
    ],
  );
}

class StateDot extends StatelessWidget {
  const StateDot(this.color, {super.key});
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox.square(dimension: 8, child: ColoredBox(color: color));
}

class TintTag extends StatelessWidget {
  const TintTag(this.text, {super.key, required this.fill, required this.ink});
  final String text;
  final Color fill;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    color: fill,
    child: Text(text, style: KitText.xs.copyWith(color: ink)),
  );
}

final okTag = (fill: Palette.leaf300.withValues(alpha: .5), ink: Palette.leaf700);
final badTag = (fill: Palette.berry.withValues(alpha: .15), ink: Palette.berry);

void openLink(String url) => launchUrl(Uri.parse(url)).catchError((Object _) => false);

class Cols extends StatelessWidget {
  const Cols({super.key, required this.columns, required this.children, this.from = 768, this.stretch = false, this.gap = 16, this.rowGap});
  final int columns;
  final List<Widget> children;
  final double from;
  final bool stretch;
  final double gap;
  final double? rowGap;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= from;
    if (!wide || columns == 1) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < children.length; i++) ...[if (i > 0) SizedBox(height: rowGap ?? gap), children[i]],
        ],
      );
    }
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i += columns) {
      final cells = children.sublist(i, i + columns > children.length ? children.length : i + columns);
      Widget row = Row(
        crossAxisAlignment: stretch ? CrossAxisAlignment.stretch : CrossAxisAlignment.start,
        children: [
          for (var j = 0; j < columns; j++) ...[if (j > 0) SizedBox(width: gap), Expanded(child: j < cells.length ? cells[j] : const SizedBox.shrink())],
        ],
      );
      if (stretch) row = IntrinsicHeight(child: row);
      if (rows.isNotEmpty) rows.add(SizedBox(height: rowGap ?? gap));
      rows.add(row);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: rows);
  }
}

String _two(int n) => n.toString().padLeft(2, '0');

String wallClockText(num at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.hour}:${_two(d.minute)}:${_two(d.second)}';
}

String momentText(num at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.year}/${d.month}/${d.day} ${_two(d.hour)}:${_two(d.minute)}:${_two(d.second)}';
}
