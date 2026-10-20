import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../common.dart';
import 'base.dart';
import 'field.dart' show ProTip;

class ProSegmented<T> extends StatelessWidget {
  const ProSegmented({super.key, required this.value, required this.options, required this.onChanged, this.block = true});
  final T value;
  final List<SegmentOption<T>> options;
  final ValueChanged<T> onChanged;

  /// false where it sits as a flex item beside others, as wide as its buttons.
  final bool block;

  @override
  Widget build(BuildContext context) {
    final strip = Container(
      padding: const EdgeInsets.all(2),
      decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
      child: Wrap(
        spacing: 2,
        runSpacing: 2,
        children: [
          for (final o in options)
            Tappable(
              onTap: o.disabled ? null : () => onChanged(o.value),
              tooltip: o.title,
              selected: o.value == value,
              builder: (context, s) {
                final on = o.value == value;
                return Opacity(
                  opacity: o.disabled ? .35 : 1,
                  child: ProFocusRing(
                    on: s.focused,
                    child: Container(
                      height: 26,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: on ? ProColor.page : (s.hovered ? ProColor.hover : null),
                        borderRadius: proRadius,
                        boxShadow: on ? const [BoxShadow(color: Color(0x1A2F1F13), blurRadius: 2, offset: Offset(0, 1))] : null,
                      ),
                      child: Center(
                        widthFactor: 1,
                        child: ProWeightText(
                          o.label,
                          style: ProText.sm.copyWith(color: on ? ProColor.ink : ProColor.muted),
                          strong: on,
                          weight: FontWeight.w500,
                          center: true,
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
    return block
        ? SizedBox(
            width: double.infinity,
            child: Align(alignment: Alignment.centerLeft, child: strip),
          )
        : strip;
  }
}

class ProPick extends StatefulWidget {
  const ProPick({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    required this.placeholder,
    this.enabled = true,
    this.semanticLabel,
    this.quiet = false,
    this.clearable = false,
  });

  final String value;
  final List<PickOption> options;
  final ValueChanged<String> onChanged;

  /// What the trigger says while nothing is chosen.
  final String placeholder;

  /// No value is a choice of its own, listed first as [placeholder] ("所有项目", "按规则挑"). Without it the list is
  /// only [options]: a pick that always has a value must not offer a second entry that means the same as one of them.
  final bool clearable;
  final bool enabled;
  final String? semanticLabel;

  /// A property's value in a side panel: no edge until hovered, as wide as its words.
  final bool quiet;

  @override
  State<ProPick> createState() => _ProPickState();
}

class _ProPickState extends State<ProPick> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  final _focus = FocusNode();
  final _group = Object();
  final _trigger = GlobalKey();
  double _width = 0;
  int _highlight = 0;

  // '' is the placeholder's own value: an option for it would show the same choice twice.
  List<PickOption> get _items => [if (widget.clearable) PickOption(value: '', label: widget.placeholder), ...widget.options.where((o) => o.value != '')];

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
    if (n == 0) return KeyEventResult.ignored;
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
    final current = _items.firstWhere(
      (o) => o.value == widget.value,
      orElse: () => PickOption(value: '', label: widget.placeholder),
    );
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
                return Tappable(
                  onTap: widget.enabled ? () => _portal.isShowing ? _close() : _open() : null,
                  semanticLabel: widget.semanticLabel,
                  builder: (context, s) => Opacity(
                    opacity: widget.enabled ? 1 : .5,
                    child: Container(
                      height: 32,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: widget.quiet
                          ? BoxDecoration(
                              color: _portal.isShowing || s.hovered ? ProColor.hover : null,
                              border: Border.all(color: s.focused ? ProColor.focus : const Color(0x00000000)),
                              borderRadius: proRadius,
                            )
                          : BoxDecoration(
                              color: s.hovered ? const Color(0xFFFFF6E6) : Palette.paper,
                              border: Border.all(color: _portal.isShowing || s.focused ? ProColor.focus : const Color(0x332F1F13)),
                              borderRadius: proRadius,
                            ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              current.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ProText.sm.copyWith(color: empty ? ProColor.faint : ProColor.ink),
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
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: const BoxDecoration(
              color: Palette.paper,
              border: Border.fromBorderSide(proLine),
              borderRadius: BorderRadius.all(Radius.circular(8)),
              boxShadow: proFloat,
            ),
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
                            decoration: BoxDecoration(color: i == highlight ? ProColor.selected : null, borderRadius: proRadius),
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    items[i].label,
                                    style: ProText.sm.copyWith(
                                      color: items[i].value == '' ? ProColor.faint : ProColor.ink,
                                      fontWeight: items[i].value == value ? FontWeight.w600 : FontWeight.w400,
                                    ),
                                  ),
                                ),
                                if (items[i].detail case final d? when d.isNotEmpty) ...[const SizedBox(width: 12), Text(d, style: ProText.meta)],
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

class ProSwitchField extends StatelessWidget {
  const ProSwitchField({super.key, required this.label, required this.checked, required this.onChanged, this.hint, this.tip, this.enabled = true});
  final String label;
  final bool checked;
  final ValueChanged<bool> onChanged;
  final String? hint;
  final String? tip;
  final bool enabled;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : .5,
    child: Semantics(
      toggled: checked,
      child: Tappable(
        onTap: enabled ? () => onChanged(!checked) : null,
        builder: (context, s) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              width: 32,
              height: 18,
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(color: checked ? ProColor.accent : const Color(0x332F1F13), borderRadius: const BorderRadius.all(Radius.circular(9))),
              child: AnimatedAlign(
                duration: const Duration(milliseconds: 150),
                alignment: checked ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  width: 14,
                  height: 14,
                  decoration: const BoxDecoration(
                    color: Palette.paper,
                    shape: BoxShape.circle,
                    boxShadow: [BoxShadow(color: Color(0x332F1F13), blurRadius: 2, offset: Offset(0, 1))],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ProTip(
                    tip: tip,
                    child: Text(label, style: ProText.sm),
                  ),
                  if (hint != null) Text(hint!, style: ProText.meta),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
