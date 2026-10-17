import 'package:flutter/widgets.dart';

import '../theme.dart';
import 'base.dart';

class TextLink extends StatelessWidget {
  const TextLink(this.text, {super.key, required this.onTap, this.underline = false, this.color = Palette.leaf700, this.style});
  final String text;
  final VoidCallback onTap;
  final bool underline;
  final Color color;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => KitTappable(
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
