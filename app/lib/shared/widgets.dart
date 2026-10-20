import 'package:flutter/widgets.dart';

export '../ui/link.dart' show InlineLink;
export 'actions.dart';

import '../ui/pixel/base.dart';
import '../ui/theme.dart';

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    child: Text(text, style: PxText.xs.copyWith(color: Palette.bark500)),
  );
}

class BadgeLabel extends StatelessWidget {
  const BadgeLabel(this.text, {super.key, this.hat = false});
  final String text;

  final bool hat;

  @override
  Widget build(BuildContext context) => Container(
    color: hat ? Palette.leaf300.withValues(alpha: .5) : Palette.cream200,
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    child: Text(text, style: PxText.xs.copyWith(color: hat ? Palette.leaf700 : Palette.bark600)),
  );
}
