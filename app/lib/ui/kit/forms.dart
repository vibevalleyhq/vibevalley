// The config pages' composite inputs: free-form chips (web/src/components/forms/chips-input.tsx) and KEY=value rows
// (key-value-editor.tsx).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import 'base.dart';
import 'field.dart' show kitBare;
import 'icons.dart';

/// Replaces web/src/components/forms/chips-input.tsx ChipsInput: chips in a cream well, then a box to type in. Enter
/// or a comma adds what is typed (split at , and ，, trimmed, without repeats), and so does leaving the box; Backspace
/// in an empty box takes the last chip off; each chip's × takes it off.
class PxChipsInput extends StatefulWidget {
  const PxChipsInput({super.key, required this.value, required this.onChanged, required this.placeholder, this.enabled = true});
  final List<String> value;
  final ValueChanged<List<String>> onChanged;
  final String placeholder;
  final bool enabled;

  @override
  State<PxChipsInput> createState() => _PxChipsInputState();
}

class _PxChipsInputState extends State<PxChipsInput> {
  final _draft = TextEditingController();
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus) _add();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _draft.dispose();
    super.dispose();
  }

  void _add() {
    final parts = <String>[];
    for (final p in _draft.text.split(RegExp('[,，]'))) {
      final t = p.trim();
      if (t.isNotEmpty && !widget.value.contains(t) && !parts.contains(t)) parts.add(t);
    }
    if (parts.isNotEmpty) widget.onChanged([...widget.value, ...parts]);
    _draft.clear();
  }

  KeyEventResult _key(FocusNode _, KeyEvent e) {
    if (e is KeyUpEvent || !widget.enabled) return KeyEventResult.ignored;
    if (e.character == ',') {
      _add();
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.backspace && _draft.text.isEmpty && widget.value.isNotEmpty) {
      widget.onChanged(widget.value.sublist(0, widget.value.length - 1));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: widget.enabled ? 1 : .5,
    child: Container(
      constraints: const BoxConstraints(minHeight: 36),
      padding: const EdgeInsets.all(6),
      color: Palette.cream100,
      foregroundDecoration: pxRing,
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final chip in widget.value)
            Container(
              color: Palette.cream300,
              padding: const EdgeInsets.only(left: 8, right: 4, top: 2, bottom: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(chip, style: KitText.xs.copyWith(color: Palette.bark800)),
                  const SizedBox(width: 4),
                  KitTappable(
                    onTap: widget.enabled ? () => widget.onChanged(widget.value.where((c) => c != chip).toList()) : null,
                    semanticLabel: '去掉 $chip',
                    builder: (context, s) => Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                      child: Opacity(opacity: s.hovered ? 1 : .7, child: const SpriteIcon('button-close', size: 10)),
                    ),
                  ),
                ],
              ),
            ),
          // flex-1 min-w-24: a Wrap cannot stretch its last child, so the box takes the whole row while there are no
          // chips (room for the placeholder) and 96 px after them.
          LayoutBuilder(
            builder: (context, c) => SizedBox(
              width: widget.value.isEmpty && c.maxWidth.isFinite ? c.maxWidth : 96,
              child: SizedBox(
                height: 24,
                child: Focus(
                  onKeyEvent: _key,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: TextField(
                        controller: _draft,
                        focusNode: _focus,
                        enabled: widget.enabled,
                        style: KitText.sm,
                        cursorColor: Palette.bark900,
                        cursorWidth: 1,
                        decoration: kitBare(
                          InputDecoration.collapsed(
                            hintText: widget.value.isEmpty ? widget.placeholder : '',
                            hintStyle: KitText.sm.copyWith(color: Palette.bark500),
                          ),
                        ),
                        onEditingComplete: () {},
                        onSubmitted: (_) {
                          _add();
                          _focus.requestFocus();
                        },
                      ),
                    ),
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

/// A slim 32 px mono input in a cream well, as the key-value rows use.
class _SlimInput extends StatefulWidget {
  const _SlimInput({super.key, required this.value, required this.onChanged, required this.enabled, this.placeholder, this.onSubmitted});
  final String value;
  final ValueChanged<String> onChanged;
  final bool enabled;
  final String? placeholder;
  final VoidCallback? onSubmitted;

  @override
  State<_SlimInput> createState() => _SlimInputState();
}

class _SlimInputState extends State<_SlimInput> {
  late final _text = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(_SlimInput old) {
    super.didUpdateWidget(old);
    if (_text.text != widget.value) {
      _text.value = TextEditingValue(
        text: widget.value,
        selection: TextSelection.collapsed(offset: widget.value.length),
      );
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Container(
    height: 32,
    alignment: Alignment.centerLeft,
    padding: const EdgeInsets.symmetric(horizontal: 10),
    color: Palette.cream100,
    foregroundDecoration: pxRing,
    child: TextField(
      controller: _text,
      enabled: widget.enabled,
      style: KitText.mono,
      cursorColor: Palette.bark900,
      cursorWidth: 1,
      decoration: kitBare(
        InputDecoration.collapsed(
          hintText: widget.placeholder,
          hintStyle: KitText.mono.copyWith(color: Palette.bark500),
        ),
      ),
      onChanged: widget.onChanged,
      onSubmitted: (_) => widget.onSubmitted?.call(),
    ),
  );
}

/// Replaces web/src/components/forms/key-value-editor.tsx KeyValueEditor: one row per KEY=value (the key fixed, the
/// value editable, 删除), then a row to add one (添加, or Enter in either box; an empty key adds nothing).
class PxKeyValueEditor extends StatefulWidget {
  const PxKeyValueEditor({
    super.key,
    required this.value,
    required this.onChanged,
    this.enabled = true,
    this.keyPlaceholder = 'KEY',
    this.valuePlaceholder = 'value',
  });

  final Map<String, String> value;
  final ValueChanged<Map<String, String>> onChanged;
  final bool enabled;
  final String keyPlaceholder;
  final String valuePlaceholder;

  @override
  State<PxKeyValueEditor> createState() => _PxKeyValueEditorState();
}

class _PxKeyValueEditorState extends State<PxKeyValueEditor> {
  String _k = '';
  String _v = '';

  void _submit() {
    final key = _k.trim();
    if (key.isEmpty) return;
    widget.onChanged({...widget.value, key: _v});
    setState(() {
      _k = '';
      _v = '';
    });
  }

  Widget _row(Widget key, Widget value, Widget action) => LayoutBuilder(
    builder: (context, c) => Row(
      children: [
        SizedBox(width: c.maxWidth.isFinite ? (c.maxWidth * .4).clamp(0, 160).toDouble() : 160, child: key),
        const SizedBox(width: 6),
        Expanded(child: value),
        const SizedBox(width: 6),
        action,
      ],
    ),
  );

  Widget _textButton(String label, VoidCallback? onTap, {bool add = false}) => KitTappable(
    onTap: onTap,
    builder: (context, s) {
      final Widget b = Container(
        height: 32,
        padding: EdgeInsets.symmetric(horizontal: add ? 12 : 8),
        color: add ? (s.hovered ? Palette.cream300.withValues(alpha: .6) : Palette.cream300) : (s.hovered ? Palette.cream200 : null),
        foregroundDecoration: pxRing,
        child: Center(
          widthFactor: 1,
          child: Text(label, style: KitText.xs.copyWith(color: add ? Palette.bark800 : (s.hovered ? Palette.berry : Palette.bark600))),
        ),
      );
      final sunk = s.pressed ? Transform.translate(offset: const Offset(1, 1), child: b) : b;
      return add ? Opacity(opacity: s.enabled ? 1 : .4, child: sunk) : sunk;
    },
  );

  @override
  Widget build(BuildContext context) {
    final on = widget.enabled;
    return Opacity(
      opacity: on ? 1 : .5,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final MapEntry(:key, value: val) in widget.value.entries) ...[
            _row(
              Container(
                color: Palette.cream200,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                child: Text(
                  key,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: KitText.mono.copyWith(color: Palette.bark800),
                ),
              ),
              _SlimInput(key: ValueKey(key), value: val, enabled: on, onChanged: (v) => widget.onChanged({...widget.value, key: v})),
              _textButton(
                '删除',
                on
                    ? () => widget.onChanged({
                        for (final e in widget.value.entries)
                          if (e.key != key) e.key: e.value,
                      })
                    : null,
              ),
            ),
            const SizedBox(height: 6),
          ],
          _row(
            _SlimInput(value: _k, enabled: on, placeholder: widget.keyPlaceholder, onChanged: (v) => setState(() => _k = v), onSubmitted: _submit),
            _SlimInput(value: _v, enabled: on, placeholder: widget.valuePlaceholder, onChanged: (v) => setState(() => _v = v), onSubmitted: _submit),
            _textButton('添加', on && _k.trim().isNotEmpty ? _submit : null, add: true),
          ),
        ],
      ),
    );
  }
}
