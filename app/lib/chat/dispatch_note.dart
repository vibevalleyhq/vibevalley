import 'package:flutter/material.dart';

import '../ui/kit/kit.dart';

/// The farm's note of a dispatch: one clipped line until it is opened, then the whole task in its place.
class DispatchNote extends StatefulWidget {
  const DispatchNote(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;

  @override
  State<DispatchNote> createState() => _DispatchNoteState();
}

class _DispatchNoteState extends State<DispatchNote> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final line = widget.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return KitTappable(
      onTap: () => setState(() => _open = !_open),
      semanticLabel: _open ? '收起派活' : '展开派活',
      builder: (context, s) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: _open
                ? PxMarkdown(widget.text, mentions: true, style: widget.style)
                : Text(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm.merge(widget.style)),
          ),
          const SizedBox(width: 6),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Opacity(opacity: s.hovered || s.focused ? 1 : .6, child: SpriteIcon(_open ? 'button-collapse' : 'button-enlarge', size: 12)),
          ),
        ],
      ),
    );
  }
}
