import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import 'base.dart';
import 'icons.dart';

class SegmentOption<T> {
  const SegmentOption({required this.value, required this.label, this.disabled = false, this.title});
  final T value;
  final String label;
  final bool disabled;

  final String? title;
}

class PxSegmented<T> extends StatelessWidget {
  const PxSegmented({super.key, required this.value, required this.options, required this.onChanged, this.block = true});
  final T value;
  final List<SegmentOption<T>> options;
  final ValueChanged<T> onChanged;

  /// false where it sits as a flex item beside others, as wide as its buttons.
  final bool block;

  @override
  Widget build(BuildContext context) {
    final strip = Container(
      color: Palette.cream200,
      padding: const EdgeInsets.all(4),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          for (final o in options)
            KitTappable(
              onTap: o.disabled ? null : () => onChanged(o.value),
              tooltip: o.title,
              selected: o.value == value,
              builder: (context, s) {
                final on = o.value == value;
                Widget b = Container(
                  height: 28,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  // The inset line wins over the chosen one's drop.
                  decoration: BoxDecoration(color: on ? Palette.leaf500 : (s.hovered ? Palette.cream300 : null)),
                  foregroundDecoration: pxRing,
                  child: Center(
                    widthFactor: 1,
                    child: Text(o.label, style: KitText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
                  ),
                );
                if (s.pressed) b = Transform.translate(offset: const Offset(1, 1), child: b);
                return Opacity(opacity: o.disabled ? .35 : 1, child: b);
              },
            ),
        ],
      ),
    );
    return block ? FillWidth(child: strip) : strip;
  }
}

class PickOption {
  const PickOption({required this.value, required this.label, this.detail});
  final String value;
  final String label;
  final String? detail;
}

class PxPick extends StatefulWidget {
  const PxPick({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    required this.placeholder,
    this.enabled = true,
    this.semanticLabel,
  });

  final String value;
  final List<PickOption> options;
  final ValueChanged<String> onChanged;
  final String placeholder;
  final bool enabled;
  final String? semanticLabel;

  @override
  State<PxPick> createState() => _PxPickState();
}

class _PxPickState extends State<PxPick> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  final _focus = FocusNode();
  final _group = Object();
  final _trigger = GlobalKey();
  double _width = 0;
  int _highlight = 0;

  List<PickOption> get _items => [PickOption(value: '', label: widget.placeholder), ...widget.options];

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  void _open() {
    if (!widget.enabled) return;
    final at = _items.indexWhere((o) => o.value == widget.value);
    final box = _trigger.currentContext?.findRenderObject();
    setState(() {
      _highlight = at < 0 ? 0 : at;
      _width = box is RenderBox && box.hasSize ? box.size.width : 0;
    });
    _portal.show();
    _focus.requestFocus();
  }

  void _close() {
    if (_portal.isShowing) setState(_portal.hide);
  }

  void _pick(String v) {
    _close();
    if (v != widget.value) widget.onChanged(v);
  }

  KeyEventResult _key(FocusNode _, KeyEvent e) {
    if (!_portal.isShowing || e is KeyUpEvent) return KeyEventResult.ignored;
    final n = _items.length;
    switch (e.logicalKey) {
      case LogicalKeyboardKey.arrowDown:
        setState(() => _highlight = (_highlight + 1) % n);
      case LogicalKeyboardKey.arrowUp:
        setState(() => _highlight = (_highlight - 1 + n) % n);
      case LogicalKeyboardKey.enter || LogicalKeyboardKey.space:
        _pick(_items[_highlight].value);
      case LogicalKeyboardKey.escape:
        _close();
      default:
        return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final current = _items.firstWhere((o) => o.value == widget.value, orElse: () => _items.first);
    final empty = current.value == '';
    return Focus(
      focusNode: _focus,
      onKeyEvent: _key,
      child: TapRegion(
        groupId: _group,
        onTapOutside: (_) => _close(),
        child: CompositedTransformTarget(
          link: _link,
          child: OverlayPortal(
            controller: _portal,
            overlayChildBuilder: (context) => CompositedTransformFollower(
              link: _link,
              targetAnchor: Alignment.bottomLeft,
              offset: const Offset(0, 6),
              child: Align(
                alignment: Alignment.topLeft,
                child: TapRegion(
                  groupId: _group,
                  child: _PickPopup(
                    items: _items,
                    value: widget.value,
                    highlight: _highlight,
                    minWidth: _width,
                    onHover: (i) => setState(() => _highlight = i),
                    onPick: _pick,
                  ),
                ),
              ),
            ),
            child: Builder(
              key: _trigger,
              builder: (context) {
                return KitTappable(
                  onTap: widget.enabled ? () => _portal.isShowing ? _close() : _open() : null,
                  semanticLabel: widget.semanticLabel,
                  builder: (context, s) => Opacity(
                    opacity: widget.enabled ? 1 : .5,
                    child: Container(
                      height: 36,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      color: Palette.cream100,
                      foregroundDecoration: pxRing,
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              current.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: KitText.sm.copyWith(color: empty ? Palette.bark500 : Palette.bark900),
                            ),
                          ),
                          const SizedBox(width: 8),
                          const RotatedBox(quarterTurns: 1, child: SpriteIcon('button-next', size: 12)),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _PickPopup extends StatelessWidget {
  const _PickPopup({required this.items, required this.value, required this.highlight, required this.minWidth, required this.onHover, required this.onPick});
  final List<PickOption> items;
  final String value;
  final int highlight;
  final double minWidth;
  final ValueChanged<int> onHover;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    tween: Tween(begin: 0, end: 1),
    duration: const Duration(milliseconds: 100),
    builder: (context, t, child) => Opacity(
      opacity: t,
      child: Transform.scale(scale: .95 + .05 * t, alignment: Alignment.topCenter, child: child),
    ),
    child: ConstrainedBox(
      constraints: BoxConstraints(minWidth: minWidth, maxHeight: MediaQuery.sizeOf(context).height * .5),
      child: IntrinsicWidth(
        child: Material(
          type: MaterialType.transparency,
          child: PxWindow(
            padding: const EdgeInsets.all(4),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < items.length; i++)
                    MouseRegion(
                      onEnter: (_) => onHover(i),
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () => onPick(items[i].value),
                        child: Semantics(
                          button: true,
                          selected: items[i].value == value,
                          child: Container(
                            color: i == highlight ? Palette.cream200 : null,
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    items[i].label,
                                    style: KitText.sm.copyWith(
                                      color: items[i].value == ''
                                          ? Palette.bark500
                                          : items[i].value == value
                                          ? Palette.leaf700
                                          : Palette.bark800,
                                    ),
                                  ),
                                ),
                                if (items[i].detail case final d? when d.isNotEmpty) ...[
                                  const SizedBox(width: 12),
                                  Text(d, style: KitText.xs.copyWith(color: Palette.bark500)),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class PxSwitchField extends StatelessWidget {
  const PxSwitchField({super.key, required this.label, required this.checked, required this.onChanged, this.hint, this.enabled = true});
  final String label;
  final bool checked;
  final ValueChanged<bool> onChanged;
  final String? hint;
  final bool enabled;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : .5,
    child: Semantics(
      toggled: checked,
      child: KitTappable(
        onTap: enabled ? () => onChanged(!checked) : null,
        builder: (context, s) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              width: 40,
              height: 24,
              // The inner line is the padding: the 20 px thumb travels 16 px.
              decoration: BoxDecoration(
                color: checked ? Palette.leaf500 : Palette.cream300.withValues(alpha: .7),
                border: Border.all(color: Palette.cream300, width: 2),
              ),
              child: AnimatedAlign(
                duration: const Duration(milliseconds: 150),
                alignment: checked ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  width: 20,
                  height: 20,
                  decoration: const BoxDecoration(color: Palette.cream50, boxShadow: kitDrop),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Flexible(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: KitText.sm),
                  if (hint != null) Text(hint!, style: KitText.fine.copyWith(color: Palette.bark500)),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
