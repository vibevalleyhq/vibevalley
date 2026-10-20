import 'package:flutter/material.dart';

import '../ui/pixel/pixel.dart';
import '../shared/chat_rules.dart';
import '../shared/chat_widgets.dart';

class CountChip extends StatelessWidget {
  const CountChip(this.count, {super.key, this.fill = Palette.bark900, this.ink = Palette.cream50});
  final int count;
  final Color fill;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    color: fill,
    child: Text('$count', style: PxText.xs.copyWith(color: ink)),
  );
}

/// A message in a conversation, said in the pixel font. A long one ([readsLong]) shows its first lines and opens in the
/// reading font; one still streaming ([folds] false) is shown whole, so it does not fold as it grows.
class ChatText extends StatefulWidget {
  const ChatText(this.text, {super.key, this.mentions = true, this.style, this.folds = true, this.link = Palette.leaf700});
  final String text;
  final bool mentions;
  final TextStyle? style;
  final bool folds;
  final Color link;

  static const _lines = 6;

  @override
  State<ChatText> createState() => _ChatTextState();
}

class _ChatTextState extends State<ChatText> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (!widget.folds || !readsLong(widget.text)) return PxMarkdown(widget.text, mentions: widget.mentions, style: widget.style);
    final said = DefaultTextStyle.of(context).style.merge(widget.style);
    final body = _open
        ? PxMarkdown(widget.text, mentions: widget.mentions, style: widget.style, reading: true)
        // Markdown has no line clamp: it is cut at the lines' height instead, and fades out so the cut line does not read as text.
        : ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (r) => const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xFFFFFFFF), Color(0xFFFFFFFF), Color(0x00FFFFFF)],
              stops: [0, .7, 1],
            ).createShader(r),
            child: ClipRect(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: ChatText._lines * (said.fontSize ?? 12) * (said.height ?? 1.625)),
                child: OverflowBox(
                  alignment: Alignment.topLeft,
                  maxHeight: double.infinity,
                  child: PxMarkdown(widget.text, mentions: widget.mentions, style: widget.style),
                ),
              ),
            ),
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        body,
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Tappable(
            onTap: () => setState(() => _open = !_open),
            semanticLabel: _open ? '收起' : '展开阅读',
            builder: (context, s) => Text(
              _open ? '收起' : '展开阅读',
              style: PxText.xs.copyWith(color: widget.link, decoration: s.hovered ? TextDecoration.underline : null, decorationColor: widget.link),
            ),
          ),
        ),
      ],
    );
  }
}

class NamingMenu extends StatelessWidget {
  const NamingMenu({super.key, required this.naming, required this.highlight, this.faceSize = 24, this.everyoneMark = true});
  final Naming naming;
  final Color highlight;
  final double faceSize;
  final bool everyoneMark;

  @override
  Widget build(BuildContext context) {
    final shown = naming.offered;
    // Inside the input's tap region: picking a name keeps the focus in the input.
    return TextFieldTapRegion(
      child: Semantics(
        label: '叫谁',
        container: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, n) in shown.indexed)
              MouseRegion(
                onEnter: (_) => naming.hover(i),
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    naming.choose(n);
                    naming.focus.requestFocus();
                  },
                  child: Semantics(
                    selected: i == naming.active,
                    button: true,
                    child: Container(
                      color: i == naming.active ? highlight : null,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      child: Row(
                        children: [
                          NameableFace(n, size: faceSize, everyoneMark: everyoneMark),
                          const SizedBox(width: 8),
                          Text(n.token, style: PxText.mono),
                          const SizedBox(width: 8),
                          if (n.session != null) ...[Text(n.name, style: PxText.sm.copyWith(color: Palette.bark800)), const SizedBox(width: 8)],
                          Expanded(
                            child: Text(
                              n.note,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: PxText.xs.copyWith(color: Palette.bark500),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
