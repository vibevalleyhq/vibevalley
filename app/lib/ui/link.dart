import 'package:flutter/widgets.dart';
import 'tappable.dart';
import 'theme.dart';

class TextLink extends StatelessWidget {
  const TextLink(this.text, {super.key, required this.onTap, this.underline = false, this.color = Palette.leaf700, this.style});
  final String text;
  final VoidCallback onTap;
  final bool underline;
  final Color color;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    builder: (context, s) => Text(
      text,
      style: (style ?? DefaultTextStyle.of(context).style).copyWith(
        color: color,
        decoration: underline || s.hovered ? TextDecoration.underline : null,
        decorationColor: color,
      ),
    ),
  );
}

/// A link in a line of text: it takes the line's style and colours it.
class InlineLink extends StatelessWidget {
  const InlineLink(this.text, {super.key, required this.onTap, this.color = Palette.leaf700});
  final String text;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    semanticLabel: text,
    builder: (context, s) => Text(
      text,
      style: (DefaultTextStyle.of(context).style).copyWith(color: color, decoration: s.hovered ? TextDecoration.underline : null, decorationColor: color),
    ),
  );
}
