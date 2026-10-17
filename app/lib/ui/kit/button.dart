import 'package:flutter/widgets.dart';

import '../theme.dart';
import 'base.dart';
import 'icons.dart';

enum PxTone { plain, primary, danger, accent }

enum PxSize { md, sm, icon, custom }

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

  final String? tooltip;

  /// For icon buttons.
  final String? semanticLabel;

  final EdgeInsets? padding;
  final FocusNode? focusNode;
  final bool autofocus;

  static (Color, Color, Color) _colors(PxTone tone) => switch (tone) {
    PxTone.plain => (Palette.cream50, Palette.creamHover, Palette.bark900),
    PxTone.primary => (Palette.leaf500, Palette.leafHover, Palette.cream50),
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
          // The aside goes under the title when both do not fit, instead of squeezing the title to a letter a line.
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 4,
            children: [
              Text(title!, style: KitText.sm),
              if (aside != null)
                DefaultTextStyle(
                  style: KitText.xs.copyWith(color: Palette.bark500),
                  child: aside!,
                ),
            ],
          ),
          const SizedBox(height: 12),
        ],
        child,
      ],
    ),
  );
}
