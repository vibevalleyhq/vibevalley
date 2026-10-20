import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../../ui/pro/pro.dart';

export '../../shared/actions.dart' show runAction;

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
                    style: ProText.xs.copyWith(color: ProColor.faint, fontWeight: FontWeight.w400),
                  ),
              ],
            ),
            style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
          ),
          if (aside != null) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: DefaultTextStyle(style: ProText.meta, maxLines: 1, overflow: TextOverflow.ellipsis, child: aside!),
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
                height: big ? 32 : 28,
                padding: EdgeInsets.symmetric(horizontal: big ? 12 : 10),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: v == value ? ProColor.selected : (s.hovered ? ProColor.hover : null), borderRadius: proRadius),
                child: ProWeightText(
                  label,
                  style: (big ? ProText.sm : ProText.xs).copyWith(color: v == value || s.hovered ? ProColor.ink : ProColor.muted),
                  strong: v == value,
                  center: true,
                ),
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
      padding: small ? const EdgeInsets.symmetric(horizontal: 8, vertical: 2) : const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: on ? ProColor.accent : (s.hovered ? ProColor.selected : ProColor.hover),
        borderRadius: const BorderRadius.all(Radius.circular(12)),
      ),
      child: ProWeightText(
        label,
        style: ProText.xs.copyWith(color: on ? Palette.paper : ProColor.ink),
        strong: on,
        center: true,
      ),
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
    builder: (context, s) => ProFocusRing(
      on: s.focused,
      radius: 8,
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          color: active ? ProColor.selected : (s.hovered ? ProColor.hover : ProColor.page),
          border: Border.all(color: active ? ProColor.ink.withValues(alpha: .4) : ProColor.line),
          borderRadius: const BorderRadius.all(Radius.circular(8)),
        ),
        child: child,
      ),
    ),
  );
}

/// Nothing without a router (a widget test without one).
void workbenchGo(BuildContext context, String path) => GoRouter.maybeOf(context)?.go(path);

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
    child: Text(text, style: ProText.sm.copyWith(color: ProColor.muted)),
  );
}

class BadgeLabel extends StatelessWidget {
  const BadgeLabel(this.text, {super.key, this.hat = false});
  final String text;

  final bool hat;

  @override
  Widget build(BuildContext context) => ProTag(label: text, fill: hat ? Palette.leaf300.withValues(alpha: .5) : ProColor.selected);
}
