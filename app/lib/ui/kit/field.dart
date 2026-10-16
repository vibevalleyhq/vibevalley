import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'base.dart';
import 'icons.dart';

class PxField extends StatelessWidget {
  const PxField({super.key, required this.label, required this.child, this.hint, this.error, this.aside, this.required = false, this.optional = false});
  final String label;
  final Widget child;
  final Widget? hint;
  final String? error;
  final Widget? aside;
  final bool required;
  final bool optional;

  @override
  Widget build(BuildContext context) {
    final err = error != null && error!.isNotEmpty;
    final note = err ? Text(error!) : hint;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Expanded(
              child: Text.rich(
                TextSpan(
                  text: label,
                  children: [
                    if (required)
                      const TextSpan(
                        text: ' *',
                        style: TextStyle(color: Palette.leaf300),
                      ),
                    if (optional)
                      const TextSpan(
                        text: '  可选',
                        style: TextStyle(color: Palette.bark500),
                      ),
                  ],
                ),
                style: KitText.xs.copyWith(color: Palette.bark600),
              ),
            ),
            if (aside != null) ...[
              const SizedBox(width: 8),
              DefaultTextStyle(
                style: KitText.xs.copyWith(color: Palette.bark500),
                child: aside!,
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        child,
        if (note != null) ...[
          const SizedBox(height: 6),
          DefaultTextStyle(
            style: KitText.xs.copyWith(height: 1.625, color: err ? Palette.berry : Palette.bark500),
            child: note,
          ),
        ],
      ],
    );
  }
}

/// Follows a controlled `value` without moving the caret while the user types.
class _Synced {
  _Synced(String value) : controller = TextEditingController(text: value);
  final TextEditingController controller;

  void follow(String value) {
    if (controller.text == value) return;
    controller.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
  }
}

class _InputBox extends StatelessWidget {
  const _InputBox({required this.focused, required this.enabled, required this.child, this.height});
  final bool focused;
  final bool enabled;
  final Widget child;
  final double? height;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : .5,
    child: Container(
      height: height,
      decoration: BoxDecoration(
        color: Palette.creamInput,
        border: Border.all(color: focused ? Palette.leaf500 : Palette.bark900, width: 2),
      ),
      child: Container(
        alignment: height == null ? null : Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        foregroundDecoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: Palette.cream300, width: 2),
            left: BorderSide(color: Palette.cream300, width: 2),
          ),
        ),
        child: child,
      ),
    ),
  );
}

InputDecoration _bare(String? placeholder, TextStyle style) => kitBare(
  InputDecoration.collapsed(
    hintText: placeholder,
    hintStyle: style.copyWith(color: Palette.bark500),
  ),
);

/// The theme's borders for each state would otherwise draw a second frame inside it, since a collapsed decoration only clears `border`.
InputDecoration kitBare(InputDecoration d) => d.copyWith(
  filled: false,
  enabledBorder: InputBorder.none,
  focusedBorder: InputBorder.none,
  disabledBorder: InputBorder.none,
  errorBorder: InputBorder.none,
  focusedErrorBorder: InputBorder.none,
);

class PxTextInput extends StatefulWidget {
  const PxTextInput({
    super.key,
    required this.value,
    required this.onChanged,
    this.placeholder,
    this.mono = false,
    this.enabled = true,
    this.semanticLabel,
    this.suggestions = const [],
    this.onSubmitted,
    this.focusNode,
    this.autofocus = false,
    this.obscure = false,
    this.keyboardType,
    this.well = false,
    this.icon,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final String? placeholder;

  final String? icon;
  final bool mono;
  final bool enabled;
  final String? semanticLabel;
  final List<String> suggestions;
  final ValueChanged<String>? onSubmitted;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool obscure;
  final TextInputType? keyboardType;

  final bool well;

  @override
  State<PxTextInput> createState() => _PxTextInputState();
}

class _PxTextInputState extends State<PxTextInput> {
  late final _Synced _text = _Synced(widget.value);
  FocusNode? _own;
  FocusNode get _focus => widget.focusNode ?? (_own ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focus.addListener(_refocus);
  }

  void _refocus() => setState(() {});

  @override
  void didUpdateWidget(PxTextInput old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      (old.focusNode ?? _own)?.removeListener(_refocus);
      _focus.addListener(_refocus);
    }
    _text.follow(widget.value);
  }

  @override
  void dispose() {
    _focus.removeListener(_refocus);
    _own?.dispose();
    _text.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = widget.mono ? KitText.mono : KitText.sm;
    Widget field(TextEditingController controller, FocusNode focus, VoidCallback? submitted) => TextField(
      controller: controller,
      focusNode: focus,
      enabled: widget.enabled,
      autofocus: widget.autofocus,
      obscureText: widget.obscure,
      keyboardType: widget.keyboardType,
      style: style,
      cursorColor: Palette.bark900,
      cursorWidth: 1,
      decoration: _bare(widget.placeholder, style),
      onChanged: widget.onChanged,
      onSubmitted: (v) {
        submitted?.call();
        widget.onSubmitted?.call(v);
      },
    );
    final box = widget.suggestions.isEmpty
        ? field(_text.controller, _focus, null)
        : RawAutocomplete<String>(
            textEditingController: _text.controller,
            focusNode: _focus,
            optionsBuilder: (v) {
              final q = v.text.toLowerCase();
              return widget.suggestions.where((s) => s.toLowerCase().contains(q) && s != v.text);
            },
            onSelected: widget.onChanged,
            fieldViewBuilder: (context, controller, focus, submitted) => field(controller, focus, submitted),
            optionsViewBuilder: (context, onSelected, options) => _SuggestionList(options: options.toList(), onSelected: onSelected, mono: widget.mono),
          );
    final shown = widget.icon == null
        ? box
        : Row(
            children: [
              SpriteIcon(widget.icon!, size: 14),
              const SizedBox(width: 8),
              Expanded(child: box),
            ],
          );
    return Semantics(
      textField: true,
      label: widget.semanticLabel,
      child: widget.well
          ? Container(
              height: 36,
              alignment: Alignment.centerLeft,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              color: Palette.cream100,
              foregroundDecoration: pxRing,
              child: shown,
            )
          : _InputBox(focused: _focus.hasFocus, enabled: widget.enabled, height: 36, child: shown),
    );
  }
}

class _SuggestionList extends StatelessWidget {
  const _SuggestionList({required this.options, required this.onSelected, required this.mono});
  final List<String> options;
  final ValueChanged<String> onSelected;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final highlighted = AutocompleteHighlightedOption.of(context);
    return Align(
      alignment: Alignment.topLeft,
      // The list hangs under the box, not under the text inside it (12 px in, 8 px down, and the 2 px border).
      child: Transform.translate(
        offset: const Offset(-14, 12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 240, maxWidth: 320),
          child: Material(
            type: MaterialType.transparency,
            child: PxWindow(
              padding: const EdgeInsets.all(4),
              child: ListView(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                children: [
                  for (var i = 0; i < options.length; i++)
                    KitTappable(
                      onTap: () => onSelected(options[i]),
                      builder: (context, s) => Container(
                        color: s.hovered || i == highlighted ? Palette.cream200 : null,
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        child: Text(options[i], style: (mono ? KitText.mono : KitText.sm).copyWith(color: Palette.bark800)),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class PxTextArea extends StatefulWidget {
  const PxTextArea({
    super.key,
    required this.value,
    required this.onChanged,
    this.rows = 6,
    this.placeholder,
    this.enabled = true,
    this.readOnly = false,
    this.mono = false,
    this.semanticLabel,
    this.focusNode,
    this.autofocus = false,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final int rows;
  final String? placeholder;
  final bool enabled;
  final bool readOnly;
  final bool mono;
  final String? semanticLabel;
  final FocusNode? focusNode;
  final bool autofocus;

  @override
  State<PxTextArea> createState() => _PxTextAreaState();
}

class _PxTextAreaState extends State<PxTextArea> {
  late final _Synced _text = _Synced(widget.value);
  FocusNode? _own;
  FocusNode get _focus => widget.focusNode ?? (_own ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focus.addListener(_refocus);
  }

  void _refocus() => setState(() {});

  @override
  void didUpdateWidget(PxTextArea old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      (old.focusNode ?? _own)?.removeListener(_refocus);
      _focus.addListener(_refocus);
    }
    _text.follow(widget.value);
  }

  @override
  void dispose() {
    _focus.removeListener(_refocus);
    _own?.dispose();
    _text.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = (widget.mono ? KitText.mono : KitText.sm).copyWith(height: 1.625);
    return Semantics(
      textField: true,
      label: widget.semanticLabel,
      child: _InputBox(
        focused: _focus.hasFocus,
        enabled: widget.enabled,
        child: TextField(
          controller: _text.controller,
          focusNode: _focus,
          enabled: widget.enabled,
          readOnly: widget.readOnly,
          autofocus: widget.autofocus,
          minLines: widget.rows,
          maxLines: widget.rows,
          keyboardType: TextInputType.multiline,
          style: style,
          cursorColor: Palette.bark900,
          cursorWidth: 1,
          decoration: _bare(widget.placeholder, style),
          onChanged: widget.onChanged,
        ),
      ),
    );
  }
}
