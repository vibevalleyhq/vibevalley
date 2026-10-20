import 'package:flutter/material.dart';

import '../common.dart';
import 'base.dart';
import 'markdown.dart';

/// A part that is folded until wanted. Folded, its line still says what is inside ([summary]: "3 个文件 +40 −2"), so the
/// page reads short and nothing is hidden without a hint of it.
class ProFold extends StatefulWidget {
  const ProFold({super.key, required this.label, required this.child, this.summary, this.open = false, this.last = false});
  final String label;
  final String? summary;
  final Widget child;

  /// Open at first. It opens again when this turns true later (a review starts and the criteria are to be ticked).
  final bool open;
  final bool last;

  @override
  State<ProFold> createState() => _ProFoldState();
}

class _ProFoldState extends State<ProFold> {
  late var _open = widget.open;

  @override
  void didUpdateWidget(ProFold old) {
    super.didUpdateWidget(old);
    if (widget.open && !old.open) _open = true;
  }

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      border: Border(top: proLine, bottom: widget.last ? proLine : BorderSide.none),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Tappable(
          onTap: () => setState(() => _open = !_open),
          semanticLabel: widget.label,
          selected: _open,
          builder: (_, st) => Container(
            color: st.hovered ? ProColor.hover : null,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
            child: Row(
              children: [
                AnimatedRotation(
                  turns: _open ? .25 : 0,
                  duration: motionDuration(context, const Duration(milliseconds: 150)),
                  child: const SpriteIcon('button-next', size: 12),
                ),
                const SizedBox(width: 8),
                Text(widget.label, style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
                if (widget.summary case final s? when s.isNotEmpty) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(s, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
                  ),
                ] else
                  const Spacer(),
              ],
            ),
          ),
        ),
        AnimatedSize(
          duration: motionDuration(context, const Duration(milliseconds: 150)),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: _open ? Padding(padding: const EdgeInsets.fromLTRB(4, 0, 4, 16), child: widget.child) : const SizedBox(width: double.infinity),
        ),
      ],
    ),
  );
}

/// The rest of a list of properties, behind "更多": the few that matter stay in sight above it.
class ProMore extends StatefulWidget {
  const ProMore({super.key, required this.children, this.label = '更多'});
  final List<Widget> children;
  final String label;

  @override
  State<ProMore> createState() => _ProMoreState();
}

class _ProMoreState extends State<ProMore> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    if (widget.children.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSize(
          duration: motionDuration(context, const Duration(milliseconds: 150)),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: _open
              ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: widget.children)
              : const SizedBox(width: double.infinity),
        ),
        if (_open) const SizedBox(height: 6),
        Align(
          alignment: Alignment.centerLeft,
          child: Tappable(
            onTap: () => setState(() => _open = !_open),
            semanticLabel: _open ? '收起' : widget.label,
            builder: (_, st) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              decoration: BoxDecoration(color: st.hovered ? ProColor.hover : null, borderRadius: proRadius),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_open ? '收起' : '${widget.label}（${widget.children.length}）', style: ProText.meta),
                  const SizedBox(width: 4),
                  RotatedBox(quarterTurns: _open ? 3 : 1, child: const SpriteIcon('button-next', size: 10)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Text to read that may be long: its first [lines] lines, faded at the cut, and "展开全文" for the rest.
class ProClampedMarkdown extends StatefulWidget {
  const ProClampedMarkdown(this.text, {super.key, this.lines = 3});
  final String text;
  final int lines;

  @override
  State<ProClampedMarkdown> createState() => _ProClampedMarkdownState();
}

class _ProClampedMarkdownState extends State<ProClampedMarkdown> {
  var _open = false;

  bool get _long => widget.text.length > widget.lines * 50 || '\n'.allMatches(widget.text.trim()).length >= widget.lines;

  @override
  Widget build(BuildContext context) {
    final body = ProMarkdown(widget.text);
    if (!_long) return body;
    final height = widget.lines * (ProText.base.fontSize! * ProText.base.height!);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_open)
          body
        else
          ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (r) => const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xFFFFFFFF), Color(0xFFFFFFFF), Color(0x00FFFFFF)],
              stops: [0, .6, 1],
            ).createShader(r),
            child: ClipRect(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: height),
                child: OverflowBox(alignment: Alignment.topLeft, maxHeight: double.infinity, child: body),
              ),
            ),
          ),
        const SizedBox(height: 4),
        InlineLink(_open ? '收起' : '展开全文', onTap: () => setState(() => _open = !_open)),
      ],
    );
  }
}
