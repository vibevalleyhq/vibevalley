import 'package:flutter/widgets.dart';

import '../common.dart';
import 'base.dart';

/// `quiet` has no fill or edge until hovered: toolbars, icon buttons, the things a row of controls is mostly made of.
enum ProTone { plain, primary, danger, accent, quiet }

enum ProSize { md, sm, icon, custom }

class ProButton extends StatelessWidget {
  const ProButton({
    super.key,
    required this.child,
    required this.onPressed,
    this.tone = ProTone.plain,
    this.size = ProSize.md,
    this.tooltip,
    this.semanticLabel,
    this.padding,
    this.focusNode,
    this.autofocus = false,
  });

  ProButton.text(
    String label, {
    super.key,
    required this.onPressed,
    String? icon,
    this.tone = ProTone.plain,
    this.size = ProSize.md,
    this.tooltip,
    this.semanticLabel,
    this.padding,
    this.focusNode,
    this.autofocus = false,
  }) : child = icon == null ? Text(label) : Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon(icon, size: 14), const SizedBox(width: 6), Text(label)]);

  /// A sprite icon alone, quiet unless a tone is given.
  ProButton.icon(
    String icon, {
    super.key,
    required this.onPressed,
    required String this.semanticLabel,
    this.tone = ProTone.quiet,
    this.tooltip,
    this.focusNode,
    this.autofocus = false,
    double iconSize = 16,
  }) : child = SpriteIcon(icon, size: iconSize),
       size = ProSize.icon,
       padding = null;

  final Widget child;
  final VoidCallback? onPressed;
  final ProTone tone;
  final ProSize size;
  final String? tooltip;

  /// For icon buttons.
  final String? semanticLabel;
  final EdgeInsets? padding;
  final FocusNode? focusNode;
  final bool autofocus;

  /// Fill, fill on hover, ink, edge.
  static (Color?, Color, Color, Color?) _colors(ProTone tone) => switch (tone) {
    ProTone.plain => (ProColor.page, const Color(0xFFF6EEDD), ProColor.ink, ProColor.line),
    ProTone.primary => (Palette.leaf600, Palette.leaf700, Palette.paper, null),
    ProTone.danger => (Palette.berry, const Color(0xFFB03E30), Palette.paper, null),
    ProTone.accent => (Palette.wheat, Palette.wheatHover, ProColor.ink, null),
    ProTone.quiet => (null, ProColor.hover, ProColor.ink, null),
  };

  @override
  Widget build(BuildContext context) {
    final (fill, hover, ink, edge) = _colors(tone);
    return Tappable(
      onTap: onPressed,
      tooltip: tooltip,
      semanticLabel: semanticLabel,
      focusNode: focusNode,
      autofocus: autofocus,
      builder: (context, s) {
        final (double? w, double? h, EdgeInsets pad) = switch (size) {
          ProSize.md => (null, 32.0, const EdgeInsets.symmetric(horizontal: 12)),
          ProSize.sm => (null, 26.0, const EdgeInsets.symmetric(horizontal: 8)),
          ProSize.icon => (28.0, 28.0, EdgeInsets.zero),
          ProSize.custom => (null, null, padding ?? EdgeInsets.zero),
        };
        final shade = s.pressed
            ? Color.alphaBlend(const Color(0x142F1F13), hover)
            : s.hovered
            ? hover
            : fill;
        return Opacity(
          opacity: s.enabled ? 1 : .45,
          child: ProFocusRing(
            on: s.focused,
            child: Container(
              width: w,
              height: h,
              padding: pad,
              decoration: BoxDecoration(
                color: shade,
                // Always an edge, clear on the filled tones: a button changing tone keeps its size.
                border: Border.all(color: edge ?? const Color(0x00000000)),
                borderRadius: proRadius,
              ),
              child: Center(
                widthFactor: w == null ? 1 : null,
                heightFactor: h == null ? 1 : null,
                child: DefaultTextStyle(
                  style: ProText.sm.copyWith(color: ink, fontWeight: FontWeight.w500),
                  maxLines: 1,
                  child: child,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
