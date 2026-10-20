import 'package:flutter/material.dart';

class TapState {
  const TapState({required this.enabled, required this.hovered, required this.pressed, required this.focused});
  final bool enabled;
  final bool hovered;
  final bool pressed;

  final bool focused;
}

/// `onTap` null is disabled: not focusable, no hover.
class Tappable extends StatefulWidget {
  const Tappable({
    super.key,
    required this.onTap,
    required this.builder,
    this.tooltip,
    this.semanticLabel,
    this.focusNode,
    this.autofocus = false,
    this.selected,
  });

  final VoidCallback? onTap;
  final Widget Function(BuildContext context, TapState state) builder;
  final String? tooltip;
  final String? semanticLabel;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool? selected;

  @override
  State<Tappable> createState() => _TappableState();
}

class _TappableState extends State<Tappable> {
  bool _hovered = false;
  bool _pressed = false;
  bool _focused = false;

  @override
  void didUpdateWidget(Tappable old) {
    super.didUpdateWidget(old);
    if (widget.onTap == null) _pressed = false;
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    Widget child = FocusableActionDetector(
      enabled: enabled,
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      mouseCursor: MouseCursor.defer,
      actions: {ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) => widget.onTap?.call())},
      onShowHoverHighlight: (v) => setState(() => _hovered = v),
      onShowFocusHighlight: (v) => setState(() => _focused = v),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
        onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
        onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
        onTap: widget.onTap,
        child: widget.builder(context, TapState(enabled: enabled, hovered: enabled && _hovered, pressed: enabled && _pressed, focused: enabled && _focused)),
      ),
    );
    child = Semantics(button: true, enabled: enabled, selected: widget.selected, label: widget.semanticLabel, child: child);
    final tip = widget.tooltip;
    if (tip != null && tip.isNotEmpty) child = Tooltip(message: tip, child: child);
    return child;
  }
}
