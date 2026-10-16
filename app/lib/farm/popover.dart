// A popover anchored to what opened it (web/src/farm/Hud.tsx FarmPopup, Base UI Popover): a framed cream card above
// or below its trigger, closed by a click outside it, by Esc, or by what is in it.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../ui/kit/kit.dart';

enum PopSide { top, bottom }

class FarmPopover extends StatefulWidget {
  const FarmPopover({
    super.key,
    required this.trigger,
    required this.popup,
    this.side = PopSide.top,
    this.alignEnd = false,
    this.offset = 10,
    this.width,
    this.enabled = true,
    this.label,
  });

  /// The trigger, given whether the popover is open and how to toggle it.
  final Widget Function(BuildContext context, bool open, VoidCallback toggle) trigger;

  /// What the popover holds, given how to close it.
  final Widget Function(BuildContext context, VoidCallback close) popup;
  final PopSide side;

  /// Its right edge on the trigger's (else its left edge).
  final bool alignEnd;
  final double offset;
  final double? width;
  final bool enabled;
  final String? label;

  @override
  State<FarmPopover> createState() => _FarmPopoverState();
}

class _FarmPopoverState extends State<FarmPopover> {
  final _link = LayerLink();
  final _portal = OverlayPortalController();

  void _toggle() {
    if (!widget.enabled) return;
    setState(_portal.isShowing ? _portal.hide : _portal.show);
  }

  void _close() {
    if (_portal.isShowing) setState(_portal.hide);
  }

  @override
  Widget build(BuildContext context) {
    final top = widget.side == PopSide.top;
    final end = widget.alignEnd;
    return CompositedTransformTarget(
      link: _link,
      child: OverlayPortal(
        controller: _portal,
        overlayChildBuilder: (context) => CompositedTransformFollower(
          link: _link,
          targetAnchor: top ? (end ? Alignment.topRight : Alignment.topLeft) : (end ? Alignment.bottomRight : Alignment.bottomLeft),
          followerAnchor: top ? (end ? Alignment.bottomRight : Alignment.bottomLeft) : (end ? Alignment.topRight : Alignment.topLeft),
          offset: Offset(0, top ? -widget.offset : widget.offset),
          child: Align(
            alignment: top ? (end ? Alignment.bottomRight : Alignment.bottomLeft) : (end ? Alignment.topRight : Alignment.topLeft),
            child: TapRegion(
              groupId: this,
              onTapOutside: (_) => _close(),
              child: CallbackShortcuts(
                bindings: {const SingleActivator(LogicalKeyboardKey.escape): _close},
                child: Focus(
                  autofocus: true,
                  child: Material(
                    type: MaterialType.transparency,
                    child: SizedBox(
                      width: widget.width,
                      child: PxWindow(
                        child: DefaultTextStyle(style: KitText.sm, child: widget.popup(context, _close)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        child: TapRegion(groupId: this, child: widget.trigger(context, _portal.isShowing, _toggle)),
      ),
    );
  }
}
