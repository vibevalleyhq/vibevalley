// Small pieces the desk pages share, in the pixel skin (corners square, `ring-1` an inner cream-300 line, `shadow` a
// hard drop):
//   DeskSection   a titled block with a count and an aside (MemoryPanels.tsx Section)
//   DeskEmpty     a quiet line on a cream well, for empty and loading states (Empty)
//   DeskBadge     a small tag: 新的, 没保存, 已保存, 在场 (AgentCreator.tsx Badge)
//   DeskTabs      a row of tabs over a panel (Base UI Tabs as the desk styles them)
//   DeskPill      a round toggle: the stage's poses, the memory list's filter
//   DeskChoice    a tile that is chosen or not (the creator's species, outfits, runtimes, skills)
//   DeskLink      words that go somewhere, in leaf green (the page's text links)
//   deskRun       runs a command from a click, and says it failed in a toast (the page's `run`, which only logs)
//   deskGo        goes to a desk route

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../ui/kit/base.dart';
import '../../ui/kit/toast.dart';
import 'state.dart';

class DeskSection extends StatelessWidget {
  const DeskSection({super.key, required this.title, required this.child, this.count, this.aside});
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
                    style: KitText.xs.copyWith(color: Palette.bark600),
                  ),
              ],
            ),
            style: KitText.xs.copyWith(color: Palette.bark600),
          ),
          if (aside != null) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: DefaultTextStyle(
                  style: KitText.xs.copyWith(color: Palette.bark500),
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

class DeskEmpty extends StatelessWidget {
  const DeskEmpty(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    child: Text(text, style: KitText.xs.copyWith(color: Palette.bark500)),
  );
}

class DeskBadge extends StatelessWidget {
  const DeskBadge(this.text, {super.key, this.hat = false});
  final String text;

  /// The green one (新的, 没保存, 在场); else cream.
  final bool hat;

  @override
  Widget build(BuildContext context) => Container(
    color: hat ? Palette.leaf300.withValues(alpha: .5) : Palette.cream200,
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    child: Text(text, style: KitText.xs.copyWith(color: hat ? Palette.leaf700 : Palette.bark600)),
  );
}

class DeskTabs<T> extends StatelessWidget {
  const DeskTabs({super.key, required this.value, required this.tabs, required this.onChanged, this.big = false});
  final T value;
  final List<(T, String)> tabs;
  final ValueChanged<T> onChanged;

  /// The manager page's tabs (px-3 text-sm); the creator's are tighter (px-2.5 text-xs).
  final bool big;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        for (final (v, label) in tabs)
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: KitTappable(
              onTap: () => onChanged(v),
              selected: v == value,
              semanticLabel: label,
              builder: (context, s) => Container(
                height: 32,
                padding: EdgeInsets.symmetric(horizontal: big ? 12 : 10),
                alignment: Alignment.center,
                // focus-visible:ring-2: the skin's inner cream-300 line, on every tab.
                color: v == value ? Palette.cream300 : null,
                foregroundDecoration: pxRing,
                child: Text(label, style: KitText.xs.copyWith(color: v == value ? Palette.bark900 : (s.hovered ? Palette.bark800 : Palette.bark600))),
              ),
            ),
          ),
      ],
    ),
  );
}

class DeskPill extends StatelessWidget {
  const DeskPill({super.key, required this.label, required this.on, required this.onTap, this.small = false});
  final String label;
  final bool on;
  final VoidCallback onTap;

  /// The memory filter's (px-2 py-0.5 text-[11px]); else the stage's (px-3 py-1 text-xs).
  final bool small;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    selected: on,
    semanticLabel: label,
    builder: (context, s) => Container(
      padding: small ? const EdgeInsets.symmetric(horizontal: 8, vertical: 2) : const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      // focus-visible:ring-2 makes the skin's inner cream-300 line, and wins over the chosen one's drop.
      color: on ? Palette.leaf500 : (s.hovered ? Palette.cream300 : Palette.cream200),
      foregroundDecoration: pxRing,
      child: Text(label, style: KitText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
    ),
  );
}

class DeskChoice extends StatelessWidget {
  const DeskChoice({
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
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    selected: active,
    tooltip: tooltip,
    semanticLabel: semanticLabel,
    builder: (context, s) => Container(
      padding: padding,
      color: active ? Palette.leaf300.withValues(alpha: .5) : (s.hovered ? Palette.cream200 : Palette.cream50),
      // ring-1 / focus-visible:ring-2: the skin's inner cream-300 line, chosen or not.
      foregroundDecoration: pxRing,
      child: child,
    ),
  );
}

class DeskLink extends StatelessWidget {
  const DeskLink(this.text, {super.key, required this.onTap, this.color = Palette.leaf700});
  final String text;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    semanticLabel: text,
    builder: (context, s) => Text(
      text,
      style: (DefaultTextStyle.of(context).style).copyWith(color: color, decoration: s.hovered ? TextDecoration.underline : null, decorationColor: color),
    ),
  );
}

/// Runs a command from a click; a failure is said in a toast (the web page only logs it).
Future<T?> deskRun<T>(Future<T> Function() command) async {
  try {
    return await command();
  } on Object catch (e) {
    toasts.add(type: ToastType.error, title: '出错了', description: reasonOf(e));
    return null;
  }
}

/// Goes to a desk route (lib/app/router.dart); nothing without a router (a widget test without one).
void deskGo(BuildContext context, String path) => GoRouter.maybeOf(context)?.go(path);
