import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/remote.dart';
import '../../gen/vibevalley.dart';
import '../../rules/doc_blocks.dart';
import '../../shared/faces.dart';
import '../../shared/swatches.dart';
import '../../ui/pro/pro.dart';
import 'doc_editor_model.dart';

/// The owner's lines on the attribution bar; a helper's are its look's trim colour.
const ownerColor = Palette.cream300;

/// Who wrote a block last, as the bar beside it shows: the owner's colour, or the helper's (its profile's look, else a
/// colour picked from its id, the same every time).
Color authorColor(String updatedBy, Agent? agent) {
  if (updatedBy == docOwner) return ownerColor;
  final trim = agent?.look.trim;
  if (trim != null) return hexColor(trim);
  return hexColor(swatches.trim[updatedBy.codeUnits.fold(0, (h, c) => (h * 31 + c) & 0x7fffffff) % swatches.trim.length]);
}

TextStyle blockStyle(EditBlock b) => switch (b.type) {
  blockHeading => switch ((b.attrs.level ?? 1).round()) {
    1 => ProText.x2l,
    2 => ProText.xl,
    _ => ProText.lg,
  },
  blockCode => ProText.mono,
  blockQuote => ProText.base.copyWith(color: ProColor.muted),
  _ => ProText.base,
};

/// The blocks, one field each. Keys between blocks: Enter splits (the field's line break), Backspace at the start joins
/// the block before, Up and Down at the first and last line move to the block above and below.
class DocBlocks extends ConsumerWidget {
  const DocBlocks({super.key, required this.editor});
  final DocEditor editor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agents = ref.watch(agentsProvider).value ?? const <String, Agent>{};
    final numbers = editor.numbers;
    final rows = <Widget>[];
    String? lastAuthor;
    for (final b in editor.blocks) {
      final writing = editor.writing(b);
      rows.add(
        BlockRow(
          key: ValueKey(b.id),
          editor: editor,
          block: b,
          depth: editor.depthOf(b),
          number: numbers[b.id],
          agent: agents[b.updatedBy],
          showFace: writing || (b.updatedBy != docOwner && b.updatedBy != lastAuthor),
          writing: writing,
        ),
      );
      lastAuthor = b.updatedBy;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...rows,
        // Below the last block: a click starts a new paragraph.
        Semantics(
          button: true,
          label: '在末尾写一段',
          child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: editor.append, child: const SizedBox(height: 64)),
        ),
      ],
    );
  }
}

class BlockRow extends StatelessWidget {
  const BlockRow({
    super.key,
    required this.editor,
    required this.block,
    required this.depth,
    this.number,
    this.agent,
    this.showFace = false,
    this.writing = false,
  });
  final DocEditor editor;
  final EditBlock block;
  final int depth;
  final int? number;
  final Agent? agent;
  final bool showFace;

  /// A helper is writing it now: the bar breathes.
  final bool writing;

  @override
  Widget build(BuildContext context) {
    final b = block;
    final writer = b.updatedBy == docOwner ? '主人' : (agent?.name ?? b.updatedBy);
    return Padding(
      padding: EdgeInsets.only(top: b.type == blockHeading ? 10 : 2, bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 22,
            child: showFace ? Padding(padding: const EdgeInsets.only(top: 3), child: AgentFaceOf(b.updatedBy, size: 18)) : null,
          ),
          Tooltip(
            message: writing ? '$writer 在写' : '$writer 写的',
            waitDuration: const Duration(milliseconds: 400),
            child: Container(
              margin: const EdgeInsets.only(right: 10, top: 2),
              child: writing ? _Breathing(key: ValueKey('writing-${b.id}'), child: _bar(b)) : _bar(b),
            ),
          ),
          SizedBox(width: 20.0 * depth),
          Expanded(child: _content(context)),
        ],
      ),
    );
  }

  Widget _bar(EditBlock b) => Container(
    key: ValueKey('author-${b.id}'),
    width: writing ? 4 : 3,
    height: _barHeight(b),
    decoration: BoxDecoration(color: authorColor(b.updatedBy, agent), borderRadius: BorderRadius.circular(2)),
  );

  double _barHeight(EditBlock b) => switch (b.type) {
    blockDivider => 16,
    blockHeading => 28,
    _ => 20,
  };

  Widget _content(BuildContext context) {
    final b = block;
    if (!knownTypes.contains(b.type)) return _Placeholder('这一块是「${b.type}」，这个版本的客户端还画不了，只能看不能改');
    final field = hasText(b.type) ? BlockField(editor: editor, block: b) : null;
    final body = switch (b.type) {
      blockDivider => const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Divider(height: 1, thickness: 1, color: ProColor.line),
      ),
      blockImage => _Placeholder('图片：${b.attrs.alt ?? ''} ${b.attrs.src ?? ''}'.trim()),
      blockIssueRef => _Placeholder('工单 ${b.attrs.issueId ?? ''}'),
      blockBulleted => _gutter(const Text('•', style: ProText.base), field!),
      blockNumbered => _gutter(Text('${number ?? 1}.', style: ProText.base), field!),
      blockTodo => _gutter(_TodoBox(checked: b.attrs.checked ?? false, onTap: () => editor.toggle(b)), field!),
      blockQuote => Container(
        padding: const EdgeInsets.only(left: 12),
        decoration: const BoxDecoration(
          border: Border(left: BorderSide(color: Palette.cream300, width: 3)),
        ),
        child: field,
      ),
      blockCode => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: Palette.ink100, borderRadius: BorderRadius.circular(6)),
        child: field,
      ),
      blockMemoryItem => _gutter(Text('记性', style: ProText.meta), field!),
      _ => field!,
    };
    if (b.problem == null) return body;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        body,
        Text(b.problem!, style: ProText.xs.copyWith(color: Palette.berry)),
      ],
    );
  }

  Widget _gutter(Widget mark, Widget field) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 26,
        child: Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Align(alignment: Alignment.topLeft, child: mark),
        ),
      ),
      Expanded(child: field),
    ],
  );
}

/// The bar of a block being written: it fades in and out while the helper writes.
class _Breathing extends StatefulWidget {
  const _Breathing({super.key, required this.child});
  final Widget child;

  @override
  State<_Breathing> createState() => _BreathingState();
}

class _BreathingState extends State<_Breathing> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: Tween(begin: 0.35, end: 1.0).animate(CurvedAnimation(parent: _pulse, curve: Curves.easeInOut)),
    child: widget.child,
  );
}

class _Placeholder extends StatelessWidget {
  const _Placeholder(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    decoration: BoxDecoration(
      border: Border.all(color: ProColor.line),
      borderRadius: BorderRadius.circular(6),
      color: Palette.ink100,
    ),
    child: Text(text, style: ProText.sm.copyWith(color: ProColor.muted)),
  );
}

/// A todo's box, drawn: ticked, it fills and shows a check.
class _TodoBox extends StatelessWidget {
  const _TodoBox({required this.checked, required this.onTap});
  final bool checked;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    checked: checked,
    label: checked ? '做完了' : '没做完',
    child: GestureDetector(
      onTap: onTap,
      child: Container(
        width: 16,
        height: 16,
        margin: const EdgeInsets.only(top: 3),
        decoration: BoxDecoration(
          color: checked ? Palette.leaf500 : Palette.paper,
          border: Border.all(color: checked ? Palette.leaf600 : Palette.bark400, width: 1.5),
          borderRadius: BorderRadius.circular(3),
        ),
        child: checked ? const CustomPaint(painter: _Check()) : null,
      ),
    ),
  );
}

class _Check extends CustomPainter {
  const _Check();

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = Palette.paper
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    canvas.drawPath(
      Path()
        ..moveTo(size.width * .2, size.height * .5)
        ..lineTo(size.width * .42, size.height * .72)
        ..lineTo(size.width * .8, size.height * .28),
      p,
    );
  }

  @override
  bool shouldRepaint(_Check oldDelegate) => false;
}

/// A block's text: our own field, nothing between it and the ops.
class BlockField extends StatelessWidget {
  const BlockField({super.key, required this.editor, required this.block});
  final DocEditor editor;
  final EditBlock block;

  @override
  Widget build(BuildContext context) {
    final b = block;
    final style = blockStyle(b);
    final done = b.type == blockTodo && (b.attrs.checked ?? false);
    final shown = done ? style.copyWith(color: ProColor.muted, decoration: TextDecoration.lineThrough) : style;
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: (on) {
        if (!on) editor.flush();
      },
      onKeyEvent: (node, e) => _key(context, e, shown),
      child: Semantics(
        label: '块 ${b.id}',
        child: TextField(
          controller: b.controller,
          focusNode: b.focus,
          style: shown,
          maxLines: null,
          keyboardType: TextInputType.multiline,
          textInputAction: TextInputAction.newline,
          cursorColor: ProColor.ink,
          decoration: InputDecoration.collapsed(
            hintText: b.type == blockHeading ? '标题' : null,
            hintStyle: shown.copyWith(color: ProColor.faint),
          ),
          onChanged: (_) => editor.edited(b, b.controller.value),
        ),
      ),
    );
  }

  KeyEventResult _key(BuildContext context, KeyEvent e, TextStyle style) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final b = block;
    final v = b.controller.value;
    if (b.composing || !v.selection.isValid || !v.selection.isCollapsed) return KeyEventResult.ignored;
    final at = v.selection.extentOffset;
    if (e.logicalKey == LogicalKeyboardKey.backspace && at == 0) {
      editor.backspaceAtStart(b);
      return KeyEventResult.handled;
    }
    final up = e.logicalKey == LogicalKeyboardKey.arrowUp, down = e.logicalKey == LogicalKeyboardKey.arrowDown;
    if (!up && !down) return KeyEventResult.ignored;
    final width = (context.findRenderObject() as RenderBox?)?.size.width ?? double.infinity;
    final painter = TextPainter(
      text: TextSpan(text: v.text, style: style),
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: width);
    final y = painter.getOffsetForCaret(TextPosition(offset: at), Rect.zero).dy;
    final edge = up ? 0.0 : painter.getOffsetForCaret(TextPosition(offset: v.text.length), Rect.zero).dy;
    painter.dispose();
    if ((up && y > edge) || (down && y < edge)) return KeyEventResult.ignored;
    final next = editor.neighbour(b, up ? -1 : 1);
    if (next == null) return KeyEventResult.ignored;
    final to = up ? next.text.length : 0;
    next.controller.selection = TextSelection.collapsed(offset: to);
    next.focus.requestFocus();
    return KeyEventResult.handled;
  }
}
