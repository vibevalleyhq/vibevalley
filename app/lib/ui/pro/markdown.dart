import 'package:flutter/widgets.dart';

import '../common.dart';
import 'base.dart';

TextStyle _body(TextStyle around) => ProText.base.copyWith(color: around.color);

TextStyle _heading(TextStyle body, int level) => switch (level) {
  1 => body.copyWith(fontSize: 20, height: 28 / 20, fontWeight: FontWeight.w600),
  2 => body.copyWith(fontSize: 16, height: 24 / 16, fontWeight: FontWeight.w600),
  _ => body.copyWith(fontWeight: FontWeight.w600),
};

Widget _rule(Color color) => Container(height: 1, color: color);

/// A line is at most this many body sizes wide: a wide page would run a sentence across the screen.
const _measure = 48.0;

const _look = MdLook(body: _body, heading: _heading, monoFallback: readMonoFallback, rule: _rule, measure: _measure);

/// Everything on the workbench is read, so there is no said and read: one body, headings with weight.
class ProMarkdown extends StatelessWidget {
  const ProMarkdown(this.text, {super.key, this.mentions = false, this.onOpenLink, this.style});
  final String text;
  final bool mentions;
  final void Function(Uri uri)? onOpenLink;

  /// Only its colour is kept.
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => MarkdownView(text, look: _look, mentions: mentions, onOpenLink: onOpenLink, style: style);
}
