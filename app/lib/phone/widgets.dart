// The phone's small moving parts (web/src/index.css .phone-blink, .phone-ring): words that blink once a second, and
// a shake in whole-pixel steps while the phone rings.

import 'package:flutter/widgets.dart';

/// Dims to 0.3 for the second half of each second (phone-blink, steps(1)).
class Blink extends StatefulWidget {
  const Blink({super.key, required this.child});
  final Widget child;

  @override
  State<Blink> createState() => _BlinkState();
}

class _BlinkState extends State<Blink> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (_, child) => Opacity(opacity: _c.value < 0.5 ? 1 : 0.3, child: child),
    child: widget.child,
  );
}

/// Shakes a pixel at a time, four steps in half a second (phone-ring); still when `on` is false.
class Shake extends StatefulWidget {
  const Shake({super.key, required this.child, this.on = true});
  final Widget child;
  final bool on;

  @override
  State<Shake> createState() => _ShakeState();
}

class _ShakeState extends State<Shake> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 500));

  static const _steps = [Offset(-1, 0), Offset(1, 0), Offset(-1, -1), Offset(1, 0)];

  @override
  void initState() {
    super.initState();
    if (widget.on) _c.repeat();
  }

  @override
  void didUpdateWidget(Shake old) {
    super.didUpdateWidget(old);
    if (widget.on && !_c.isAnimating) {
      _c.repeat();
    } else if (!widget.on && _c.isAnimating) {
      _c
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (_, child) => Transform.translate(offset: widget.on ? _steps[(_c.value * 4).floor().clamp(0, 3)] : Offset.zero, child: child),
    child: widget.child,
  );
}

/// A tap target with a hover state: `builder` gets whether the pointer is over it.
class Hover extends StatefulWidget {
  const Hover({super.key, required this.builder, this.onTap, this.label});
  final Widget Function(bool hovered) builder;
  final VoidCallback? onTap;
  final String? label;

  @override
  State<Hover> createState() => _HoverState();
}

class _HoverState extends State<Hover> {
  bool _over = false;

  @override
  Widget build(BuildContext context) => Semantics(
    button: widget.onTap != null,
    label: widget.label,
    child: MouseRegion(
      cursor: widget.onTap == null ? MouseCursor.defer : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _over = true),
      onExit: (_) => setState(() => _over = false),
      child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: widget.onTap, child: widget.builder(_over && widget.onTap != null)),
    ),
  );
}
