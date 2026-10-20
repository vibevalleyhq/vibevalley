import 'package:flutter/material.dart';

import '../common.dart';
import 'base.dart';

class ProField extends StatelessWidget {
  const ProField({
    super.key,
    required this.label,
    required this.child,
    this.hint,
    this.tip,
    this.error,
    this.aside,
    this.required = false,
    this.optional = false,
  });
  final String label;
  final Widget child;
  final Widget? hint;

  /// What the field is for, shown when the label is hovered.
  final String? tip;
  final String? error;
  final Widget? aside;
  final bool required;
  final bool optional;

  @override
  Widget build(BuildContext context) {
    final err = error != null && error!.isNotEmpty;
    final note = err ? Text(error!) : hint;
    final labelText = Text.rich(
      TextSpan(
        children: [
          TextSpan(text: label),
          if (required)
            const TextSpan(
              text: ' *',
              style: TextStyle(color: Palette.berry),
            ),
          if (optional)
            const TextSpan(
              text: '  可选',
              style: TextStyle(color: ProColor.faint, fontWeight: FontWeight.w400),
            ),
        ],
      ),
      style: ProText.xs.copyWith(fontWeight: FontWeight.w500, color: Palette.bark600),
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: tip == null || tip!.isEmpty
                  ? labelText
                  : Tooltip(
                      message: tip!,
                      child: MouseRegion(cursor: SystemMouseCursors.help, child: labelText),
                    ),
            ),
            if (aside != null) ...[const SizedBox(width: 8), DefaultTextStyle(style: ProText.meta, child: aside!)],
          ],
        ),
        const SizedBox(height: 6),
        child,
        if (note != null) ...[
          const SizedBox(height: 6),
          DefaultTextStyle(
            style: ProText.meta.copyWith(color: err ? Palette.berry : ProColor.muted),
            child: note,
          ),
        ],
      ],
    );
  }
}

/// [child] with a dotted underline that shows [tip] on hover; just [child] without one.
class ProTip extends StatelessWidget {
  const ProTip({super.key, required this.tip, required this.child});
  final String? tip;
  final Text child;

  @override
  Widget build(BuildContext context) {
    final t = tip;
    if (t == null || t.isEmpty) return child;
    final style = (child.style ?? const TextStyle()).copyWith(
      decoration: TextDecoration.underline,
      decorationStyle: TextDecorationStyle.dotted,
      decorationColor: ProColor.faint,
    );
    return Tooltip(
      message: t,
      child: MouseRegion(
        cursor: SystemMouseCursors.help,
        child: Text(child.data ?? '', style: style),
      ),
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.focused, required this.enabled, required this.child, this.height});
  final bool focused;
  final bool enabled;
  final Widget child;
  final double? height;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : .5,
    child: Container(
      height: height,
      alignment: height == null ? null : Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Palette.paper,
        border: Border.all(color: focused ? ProColor.focus : const Color(0x332F1F13), width: focused ? 1.5 : 1),
        borderRadius: proRadius,
      ),
      child: child,
    ),
  );
}

/// Placeholders are Chinese hints even in a code field, so they are in the body type at the field's size.
InputDecoration _bare(String? placeholder, TextStyle style) => InputDecoration.collapsed(
  hintText: placeholder,
  hintStyle: ProText.sm.copyWith(fontSize: style.fontSize, color: ProColor.faint),
).copyWith(filled: false, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none, disabledBorder: InputBorder.none);

class ProTextInput extends StatefulWidget {
  const ProTextInput({
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
    this.icon,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final String? placeholder;
  final bool mono;
  final bool enabled;
  final String? semanticLabel;
  final List<String> suggestions;
  final ValueChanged<String>? onSubmitted;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool obscure;
  final TextInputType? keyboardType;

  /// A sprite before the text.
  final String? icon;

  @override
  State<ProTextInput> createState() => _ProTextInputState();
}

class _ProTextInputState extends State<ProTextInput> {
  late final _text = SyncedText(widget.value);
  FocusNode? _own;
  FocusNode get _focus => widget.focusNode ?? (_own ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focus.addListener(_refocus);
  }

  void _refocus() => setState(() {});

  @override
  void didUpdateWidget(ProTextInput old) {
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
    final style = widget.mono ? ProText.mono : ProText.sm;
    Widget field(TextEditingController controller, FocusNode focus, VoidCallback? submitted) => TextField(
      controller: controller,
      focusNode: focus,
      enabled: widget.enabled,
      autofocus: widget.autofocus,
      obscureText: widget.obscure,
      keyboardType: widget.keyboardType,
      style: style,
      cursorColor: ProColor.ink,
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
            optionsViewBuilder: (context, onSelected, options) => _Suggestions(options: options.toList(), onSelected: onSelected, mono: widget.mono),
          );
    return Semantics(
      textField: true,
      label: widget.semanticLabel,
      child: _Box(
        focused: _focus.hasFocus,
        enabled: widget.enabled,
        height: 32,
        child: widget.icon == null
            ? box
            : Row(
                children: [
                  SpriteIcon(widget.icon!, size: 14),
                  const SizedBox(width: 8),
                  Expanded(child: box),
                ],
              ),
      ),
    );
  }
}

class _Suggestions extends StatelessWidget {
  const _Suggestions({required this.options, required this.onSelected, required this.mono});
  final List<String> options;
  final ValueChanged<String> onSelected;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final highlighted = AutocompleteHighlightedOption.of(context);
    return Align(
      alignment: Alignment.topLeft,
      // Under the box, not under the text inside it (10 px in, 6 px down, and the hairline).
      child: Transform.translate(
        offset: const Offset(-11, 8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 240, maxWidth: 320),
          child: Material(
            type: MaterialType.transparency,
            child: Container(
              padding: const EdgeInsets.all(4),
              decoration: const BoxDecoration(
                color: Palette.paper,
                border: Border.fromBorderSide(proLine),
                borderRadius: BorderRadius.all(Radius.circular(8)),
                boxShadow: proFloat,
              ),
              child: ListView(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                children: [
                  for (var i = 0; i < options.length; i++)
                    Tappable(
                      onTap: () => onSelected(options[i]),
                      builder: (context, s) => Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                        decoration: BoxDecoration(color: s.hovered || i == highlighted ? ProColor.selected : null, borderRadius: proRadius),
                        child: Text(options[i], style: mono ? ProText.mono : ProText.sm),
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

class ProTextArea extends StatefulWidget {
  const ProTextArea({
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
    this.selection,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final int rows;

  /// What is selected when [value] is replaced from outside; the cursor goes to the end without it.
  final TextSelection? selection;
  final String? placeholder;
  final bool enabled;
  final bool readOnly;
  final bool mono;
  final String? semanticLabel;
  final FocusNode? focusNode;
  final bool autofocus;

  @override
  State<ProTextArea> createState() => _ProTextAreaState();
}

class _ProTextAreaState extends State<ProTextArea> {
  late final _text = SyncedText(widget.value);
  FocusNode? _own;
  FocusNode get _focus => widget.focusNode ?? (_own ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focus.addListener(_refocus);
  }

  void _refocus() => setState(() {});

  @override
  void didUpdateWidget(ProTextArea old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      (old.focusNode ?? _own)?.removeListener(_refocus);
      _focus.addListener(_refocus);
    }
    _text.follow(widget.value, widget.selection);
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
    final style = widget.mono ? ProText.mono : ProText.base;
    return Semantics(
      textField: true,
      label: widget.semanticLabel,
      child: _Box(
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
          cursorColor: ProColor.ink,
          cursorWidth: 1,
          decoration: _bare(widget.placeholder, style),
          onChanged: widget.onChanged,
        ),
      ),
    );
  }
}

/// A text box's look, for pro controls that hold their own TextField (chips, key and value).
BoxDecoration proBox({bool focused = false}) => BoxDecoration(
  color: Palette.paper,
  border: Border.all(color: focused ? ProColor.focus : const Color(0x332F1F13), width: focused ? 1.5 : 1),
  borderRadius: proRadius,
);

/// A bare TextField inside a pro box.
InputDecoration proBare(String? placeholder, TextStyle style) => _bare(placeholder, style);
