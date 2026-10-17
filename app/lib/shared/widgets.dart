import 'package:flutter/widgets.dart';

import '../data/remote.dart';
import '../ui/kit/base.dart';
import '../ui/kit/toast.dart';
import '../ui/theme.dart';

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    child: Text(text, style: KitText.xs.copyWith(color: Palette.bark500)),
  );
}

class InlineLink extends StatelessWidget {
  const InlineLink(this.text, {super.key, required this.onTap, this.color = Palette.leaf700});
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

Future<T?> runAction<T>(Future<T> Function() command) async {
  try {
    return await command();
  } on Object catch (e) {
    toasts.add(type: ToastType.error, title: '出错了', description: reasonOf(e));
    return null;
  }
}

class BadgeLabel extends StatelessWidget {
  const BadgeLabel(this.text, {super.key, this.hat = false});
  final String text;

  final bool hat;

  @override
  Widget build(BuildContext context) => Container(
    color: hat ? Palette.leaf300.withValues(alpha: .5) : Palette.cream200,
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    child: Text(text, style: KitText.xs.copyWith(color: hat ? Palette.leaf700 : Palette.bark600)),
  );
}
