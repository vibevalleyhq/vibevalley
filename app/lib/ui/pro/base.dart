import 'package:flutter/material.dart';

import '../common.dart';

/// The workbench's surfaces and inks, taken from the farm's palette so the two skins stay one place.
abstract final class ProColor {
  static const page = Palette.paper;
  static const side = Palette.ink100;
  static const ink = Palette.bark900;
  static const muted = Palette.bark500;
  static const faint = Palette.bark400;
  static const line = Color(0x1F2F1F13);
  static const hover = Color(0x0F2F1F13);
  static const selected = Color(0x1A2F1F13);
  static const focus = Palette.leaf500;
  static const accent = Palette.leaf600;
}

/// The workbench's type: the system's Chinese sans with weights, at the sizes a dense page needs. No pixel font here.
abstract final class ProText {
  static const xs = TextStyle(fontFamily: readFont, fontFamilyFallback: readFallback, fontSize: 12, height: 16 / 12, color: ProColor.ink);
  static const sm = TextStyle(fontFamily: readFont, fontFamilyFallback: readFallback, fontSize: 13, height: 20 / 13, color: ProColor.ink);
  static const base = TextStyle(fontFamily: readFont, fontFamilyFallback: readFallback, fontSize: 14, height: 22 / 14, color: ProColor.ink);
  static const lg = TextStyle(
    fontFamily: readFont,
    fontFamilyFallback: readFallback,
    fontSize: 16,
    height: 24 / 16,
    fontWeight: FontWeight.w600,
    color: ProColor.ink,
  );
  static const xl = TextStyle(
    fontFamily: readFont,
    fontFamilyFallback: readFallback,
    fontSize: 20,
    height: 28 / 20,
    fontWeight: FontWeight.w600,
    color: ProColor.ink,
  );
  static const x2l = TextStyle(
    fontFamily: readFont,
    fontFamilyFallback: readFallback,
    fontSize: 24,
    height: 32 / 24,
    fontWeight: FontWeight.w600,
    color: ProColor.ink,
  );
  static const mono = TextStyle(fontFamily: monoFont, fontFamilyFallback: readMonoFallback, fontSize: 12.5, height: 1.5, color: ProColor.ink);

  /// Who and when beside a name, a count, a hint.
  static const meta = TextStyle(fontFamily: readFont, fontFamilyFallback: readFallback, fontSize: 12, height: 16 / 12, color: ProColor.muted);
}

const proLine = BorderSide(color: ProColor.line);
const proRadius = BorderRadius.all(Radius.circular(6));

/// Menus, popovers and dialogs lift off the page; panels on it do not.
const proFloat = [BoxShadow(color: Color(0x262F1F13), blurRadius: 24, offset: Offset(0, 8))];

/// A flat surface with a hairline: what the pixel kit's windows and cards are on the workbench.
class ProPanel extends StatelessWidget {
  const ProPanel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.color = ProColor.page, this.radius = 8});
  final Widget child;
  final EdgeInsets padding;
  final Color color;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(color: color, border: const Border.fromBorderSide(proLine), borderRadius: BorderRadius.circular(radius)),
    child: child,
  );
}

/// The focus ring every pro control draws when the keyboard is on it.
class ProFocusRing extends StatelessWidget {
  const ProFocusRing({super.key, required this.on, required this.child, this.radius = 6});
  final bool on;
  final Widget child;
  final double radius;

  @override
  Widget build(BuildContext context) => on
      ? DecoratedBox(
          position: DecorationPosition.foreground,
          decoration: BoxDecoration(
            border: Border.all(color: ProColor.focus, width: 2, strokeAlign: BorderSide.strokeAlignOutside),
            borderRadius: BorderRadius.circular(radius),
          ),
          child: child,
        )
      : child;
}

/// How many unread: a small pill.
class ProCount extends StatelessWidget {
  const ProCount(this.count, {super.key});
  final int count;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    decoration: const BoxDecoration(color: ProColor.accent, borderRadius: BorderRadius.all(Radius.circular(9))),
    child: Text(
      '$count',
      style: ProText.xs.copyWith(color: Palette.paper, fontWeight: FontWeight.w600),
    ),
  );
}

/// A session's phase or the manager's mood: a round dot ringed in the page colour.
class ProDot extends StatelessWidget {
  const ProDot(this.color, {super.key, this.size = 9});
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: ProColor.page, width: 1.5),
    ),
  );
}

/// A small label before a message or on a card: what kind of thing it is.
class ProTag extends StatelessWidget {
  const ProTag({super.key, required this.label, required this.fill, this.icon});
  final String label;
  final Color fill;
  final String? icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(color: fill, borderRadius: const BorderRadius.all(Radius.circular(4))),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[SpriteIcon(icon!, size: 12), const SizedBox(width: 4)],
        Text(label, style: ProText.xs.copyWith(fontWeight: FontWeight.w500)),
      ],
    ),
  );
}

/// A panel with an optional title line: what PxCard is on the workbench.
class ProCard extends StatelessWidget {
  const ProCard({super.key, required this.child, this.title, this.aside, this.padding = const EdgeInsets.all(16)});
  final Widget child;
  final String? title;
  final Widget? aside;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => ProPanel(
    padding: padding,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null) ...[
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 4,
            children: [
              Text(title!, style: ProText.base.copyWith(fontWeight: FontWeight.w600)),
              if (aside != null) DefaultTextStyle(style: ProText.meta, child: aside!),
            ],
          ),
          const SizedBox(height: 12),
        ],
        child,
      ],
    ),
  );
}

/// A label that turns bold when chosen (a tab, a segment, a stage) and keeps one width either way: it always takes the
/// bold width, so choosing it does not push the labels beside it.
class ProWeightText extends StatelessWidget {
  const ProWeightText(this.text, {super.key, required this.style, required this.strong, this.weight = FontWeight.w600, this.center = false});
  final String text;
  final TextStyle style;
  final bool strong;
  final FontWeight weight;
  final bool center;

  @override
  Widget build(BuildContext context) {
    final bold = DefaultTextStyle.of(context).style.merge(style).copyWith(fontWeight: weight);
    final measure = TextPainter(
      text: TextSpan(text: text, style: bold),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = measure.width.ceilToDouble();
    measure.dispose();
    return SizedBox(
      width: width,
      child: Text(
        text,
        maxLines: 1,
        softWrap: false,
        textAlign: center ? TextAlign.center : TextAlign.start,
        style: strong ? style.copyWith(fontWeight: weight) : style,
      ),
    );
  }
}
