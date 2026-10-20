import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../ui/pro/pro.dart';

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
          child: SingleChildScrollView(
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
              child: SingleChildScrollView(child: list),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: detailScrolls ? SingleChildScrollView(padding: const EdgeInsets.only(bottom: 6), child: column) : SingleChildScrollView(child: column),
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
    child: ProPanel(
      padding: const EdgeInsets.all(8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(8, 6, 8, note == null ? 8 : 2),
            child: Text.rich(
              TextSpan(
                text: title,
                children: [
                  if (subtitle != null)
                    TextSpan(
                      text: ' $subtitle',
                      style: ProText.sm.copyWith(color: ProColor.faint, fontWeight: FontWeight.w400),
                    ),
                ],
              ),
              style: ProText.base.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: Text(note!, style: ProText.meta),
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
    padding: const EdgeInsets.only(bottom: 2),
    child: Tappable(
      onTap: onTap,
      selected: active,
      semanticLabel: semanticLabel,
      builder: (context, s) => ProFocusRing(
        on: s.focused,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: active
                ? ProColor.selected
                : s.hovered
                ? ProColor.hover
                : null,
            borderRadius: proRadius,
          ),
          child: child,
        ),
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
      Text(
        name,
        style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      Text(line, style: ProText.meta, maxLines: 1, overflow: TextOverflow.ellipsis),
      ?extra,
    ],
  );
}

class StateDot extends StatelessWidget {
  const StateDot(this.color, {super.key});
  final Color color;

  @override
  Widget build(BuildContext context) => ProDot(color, size: 8);
}

class TintTag extends StatelessWidget {
  const TintTag(this.text, {super.key, required this.fill, required this.ink});
  final String text;
  final Color fill;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(color: fill, borderRadius: const BorderRadius.all(Radius.circular(4))),
    child: Text(
      text,
      style: ProText.xs.copyWith(color: ink, fontWeight: FontWeight.w500),
    ),
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

String momentText(num at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.year}/${d.month}/${d.day} ${_two(d.hour)}:${_two(d.minute)}:${_two(d.second)}';
}
