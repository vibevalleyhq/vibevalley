import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../../ui/pixel/base.dart';
import '../../ui/theme.dart';

export '../../shared/widgets.dart' show BadgeLabel, EmptyNote, InlineLink, runAction;

class WorkbenchSection extends StatelessWidget {
  const WorkbenchSection({super.key, required this.title, required this.child, this.count, this.aside});
  final String title;
  final int? count;
  final Widget? aside;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Row(
        children: [
          Text.rich(
            TextSpan(
              text: title,
              children: [
                if (count != null && count != 0)
                  TextSpan(
                    text: ' $count',
                    style: PxText.xs.copyWith(color: Palette.bark600),
                  ),
              ],
            ),
            style: PxText.xs.copyWith(color: Palette.bark600),
          ),
          if (aside != null) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: DefaultTextStyle(
                  style: PxText.xs.copyWith(color: Palette.bark500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  child: aside!,
                ),
              ),
            ),
          ],
        ],
      ),
      const SizedBox(height: 6),
      child,
    ],
  );
}

class WorkbenchTabs<T> extends StatelessWidget {
  const WorkbenchTabs({super.key, required this.value, required this.tabs, required this.onChanged, this.big = false});
  final T value;
  final List<(T, String)> tabs;
  final ValueChanged<T> onChanged;

  final bool big;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        for (final (v, label) in tabs)
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Tappable(
              onTap: () => onChanged(v),
              selected: v == value,
              semanticLabel: label,
              builder: (context, s) => Container(
                height: 32,
                padding: EdgeInsets.symmetric(horizontal: big ? 12 : 10),
                alignment: Alignment.center,
                color: v == value ? Palette.cream300 : null,
                foregroundDecoration: pxRing,
                child: Text(label, style: PxText.xs.copyWith(color: v == value ? Palette.bark900 : (s.hovered ? Palette.bark800 : Palette.bark600))),
              ),
            ),
          ),
      ],
    ),
  );
}

class WorkbenchPill extends StatelessWidget {
  const WorkbenchPill({super.key, required this.label, required this.on, required this.onTap, this.small = false});
  final String label;
  final bool on;
  final VoidCallback onTap;

  final bool small;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: on,
    semanticLabel: label,
    builder: (context, s) => Container(
      padding: small ? const EdgeInsets.symmetric(horizontal: 8, vertical: 2) : const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: on ? Palette.leaf500 : (s.hovered ? Palette.cream300 : Palette.cream200),
      foregroundDecoration: pxRing,
      child: Text(label, style: PxText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
    ),
  );
}

class WorkbenchChoice extends StatelessWidget {
  const WorkbenchChoice({
    super.key,
    required this.active,
    required this.onTap,
    required this.child,
    this.tooltip,
    this.semanticLabel,
    this.padding = const EdgeInsets.all(4),
  });
  final bool active;
  final VoidCallback? onTap;
  final Widget child;
  final String? tooltip;
  final String? semanticLabel;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: active,
    tooltip: tooltip,
    semanticLabel: semanticLabel,
    builder: (context, s) => Container(
      padding: padding,
      color: active ? Palette.leaf300.withValues(alpha: .5) : (s.hovered ? Palette.cream200 : Palette.cream50),
      foregroundDecoration: pxRing,
      child: child,
    ),
  );
}

/// Nothing without a router (a widget test without one).
void workbenchGo(BuildContext context, String path) => GoRouter.maybeOf(context)?.go(path);
