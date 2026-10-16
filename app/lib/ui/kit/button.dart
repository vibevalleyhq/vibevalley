// The button (web/src/components/ui/button.tsx) and the card (card.tsx), in the pixel skin.

import 'package:flutter/widgets.dart';

import '../../app/theme.dart';
import 'base.dart';
import 'icons.dart';

/// The button's colours (button.tsx `tones`).
enum PxTone { plain, primary, danger, accent }

/// The button's sizes (button.tsx `sizes`): md 36 px tall, sm 28, icon a 36 px square, custom sized by its content.
enum PxSize { md, sm, icon, custom }

/// Replaces web/src/components/ui/button.tsx Button (and `buttonClass` for links): a 2 px bark outline, a hard drop
/// that goes away as it sinks 2 px when pressed, a 2 px leaf outline 1 px out on keyboard focus, 45% opacity when
/// disabled (`onPressed` null).
class PxButton extends StatelessWidget {
  const PxButton({
    super.key,
    required this.child,
    required this.onPressed,
    this.tone = PxTone.plain,
    this.size = PxSize.md,
    this.tooltip,
    this.semanticLabel,
    this.padding,
    this.focusNode,
    this.autofocus = false,
  });

  /// A button that says `label`, after the pixel glyph `icon` when it has one.
  PxButton.text(
    String label, {
    super.key,
    required this.onPressed,
    String? icon,
    this.tone = PxTone.plain,
    this.size = PxSize.md,
    this.tooltip,
    this.semanticLabel,
    this.padding,
    this.focusNode,
    this.autofocus = false,
  }) : child = icon == null ? Text(label) : Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon(icon, size: 14), const SizedBox(width: 6), Text(label)]);

  final Widget child;
  final VoidCallback? onPressed;
  final PxTone tone;
  final PxSize size;

  /// The page's `title`.
  final String? tooltip;

  /// The page's `aria-label`, for icon buttons.
  final String? semanticLabel;

  /// Only for PxSize.custom (the page's className padding).
  final EdgeInsets? padding;
  final FocusNode? focusNode;
  final bool autofocus;

  static (Color, Color, Color) _colors(PxTone tone) => switch (tone) {
    PxTone.plain => (Palette.cream50, Palette.creamHover, Palette.bark900),
    PxTone.primary => (Palette.leaf500, Palette.leafHover, Palette.cream50),
    // hover: brightness-95
    PxTone.danger => (
      Palette.berry,
      Color.from(alpha: 1, red: Palette.berry.r * .95, green: Palette.berry.g * .95, blue: Palette.berry.b * .95),
      Palette.cream50,
    ),
    PxTone.accent => (Palette.wheat, Palette.wheatHover, Palette.bark900),
  };

  @override
  Widget build(BuildContext context) {
    final (fill, hover, ink) = _colors(tone);
    return KitTappable(
      onTap: onPressed,
      tooltip: tooltip,
      semanticLabel: semanticLabel,
      focusNode: focusNode,
      autofocus: autofocus,
      builder: (context, s) {
        final (double? w, double? h, EdgeInsets pad) = switch (size) {
          PxSize.md => (null, 36.0, const EdgeInsets.symmetric(horizontal: 16)),
          PxSize.sm => (null, 28.0, const EdgeInsets.symmetric(horizontal: 8)),
          PxSize.icon => (36.0, 36.0, EdgeInsets.zero),
          PxSize.custom => (null, null, padding ?? EdgeInsets.zero),
        };
        final sunk = s.pressed;
        Widget box = Container(
          width: w,
          height: h,
          padding: pad,
          decoration: BoxDecoration(
            color: s.hovered ? hover : fill,
            border: Border.all(color: Palette.bark900, width: 2),
            boxShadow: sunk ? null : kitDrop,
          ),
          child: Center(
            widthFactor: w == null ? 1 : null,
            heightFactor: h == null ? 1 : null,
            child: DefaultTextStyle(
              style: KitText.sm.copyWith(color: ink),
              maxLines: 1,
              child: IconTheme.merge(
                data: IconThemeData(color: ink),
                child: child,
              ),
            ),
          ),
        );
        if (s.focused) box = CustomPaint(foregroundPainter: const _FocusRing(), child: box);
        if (sunk) box = Transform.translate(offset: const Offset(2, 2), child: box);
        return Opacity(opacity: s.enabled ? 1 : .45, child: box);
      },
    );
  }
}

/// focus-visible: outline 2px leaf-500, offset 1px.
class _FocusRing extends CustomPainter {
  const _FocusRing();

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = Palette.leaf500
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRect((Offset.zero & size).inflate(2), p);
  }

  @override
  bool shouldRepaint(_FocusRing old) => false;
}

/// Replaces web/src/components/ui/card.tsx Card (.farm-card): cream paper in the pixel frame, 16 px in; an optional
/// title row with `aside` at its right in small brown words.
class PxCard extends StatelessWidget {
  const PxCard({super.key, required this.child, this.title, this.aside, this.padding = const EdgeInsets.all(16)});
  final Widget child;
  final String? title;
  final Widget? aside;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => PxWindow(
    paper: Palette.cream50,
    padding: padding,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null) ...[
          Row(
            children: [
              Expanded(child: Text(title!, style: KitText.sm)),
              if (aside != null) ...[
                const SizedBox(width: 8),
                DefaultTextStyle(
                  style: KitText.xs.copyWith(color: Palette.bark500),
                  child: aside!,
                ),
              ],
            ],
          ),
          const SizedBox(height: 12),
        ],
        child,
      ],
    ),
  );
}
