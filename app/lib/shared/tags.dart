import 'package:flutter/material.dart';

import '../ui/pixel/pixel.dart';

class FarmTag extends StatelessWidget {
  const FarmTag(this.text, {super.key, this.fill = Palette.cream200, this.ink = Palette.bark800, this.icon, this.goes = false});
  final String text;
  final Color fill;
  final Color ink;

  final String? icon;

  final bool goes;

  @override
  Widget build(BuildContext context) => Container(
    color: fill,
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[SpriteIcon(icon!, size: 12), const SizedBox(width: 4)],
        Text(text, maxLines: 1, style: PxText.xs.copyWith(color: ink)),
        if (goes) ...[const SizedBox(width: 4), const SpriteIcon('button-next', size: 10)],
      ],
    ),
  );
}

class Tinted extends StatelessWidget {
  const Tinted({super.key, required this.child, this.color = Palette.cream100, this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 8)});
  final Widget child;
  final Color color;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(color: color, padding: padding, child: child);
}

Color tint(Color c, double alpha) => Color.alphaBlend(c.withValues(alpha: alpha), Palette.cream50);
