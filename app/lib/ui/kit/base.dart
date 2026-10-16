import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../app/theme.dart';

/// Line heights are Tailwind's for each size: the skin changes the size, not the line height.
abstract final class KitText {
  static const xs = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const fine = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.5, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const sm = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 20 / 14, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const base = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.5, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const lg = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 18, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const xl = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const x2l = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 32 / 24, fontWeight: FontWeight.w400, color: Palette.bark900);

  static const mono = TextStyle(fontFamily: monoFont, fontFamilyFallback: monoFallback, fontSize: 12, height: 4 / 3, color: Palette.bark900);
}

Duration kitMotion(BuildContext context, Duration d) => (MediaQuery.maybeDisableAnimationsOf(context) ?? false) ? Duration.zero : d;

bool kitMoves(BuildContext context) => !(MediaQuery.maybeDisableAnimationsOf(context) ?? false);

const kitDrop = [BoxShadow(color: Palette.pxDrop, offset: Offset(2, 2))];

class KitState {
  const KitState({required this.enabled, required this.hovered, required this.pressed, required this.focused});
  final bool enabled;
  final bool hovered;
  final bool pressed;

  final bool focused;
}

/// `onTap` null is disabled: not focusable, no hover.
class KitTappable extends StatefulWidget {
  const KitTappable({
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
  final Widget Function(BuildContext context, KitState state) builder;
  final String? tooltip;
  final String? semanticLabel;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool? selected;

  @override
  State<KitTappable> createState() => _KitTappableState();
}

class _KitTappableState extends State<KitTappable> {
  bool _hovered = false;
  bool _pressed = false;
  bool _focused = false;

  @override
  void didUpdateWidget(KitTappable old) {
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
        child: widget.builder(context, KitState(enabled: enabled, hovered: enabled && _hovered, pressed: enabled && _pressed, focused: enabled && _focused)),
      ),
    );
    child = Semantics(button: true, enabled: enabled, selected: widget.selected, label: widget.semanticLabel, child: child);
    final tip = widget.tooltip;
    if (tip != null && tip.isNotEmpty) child = Tooltip(message: tip, child: child);
    return child;
  }
}

/// `border` (0 or 2) is a border inside the frame, under which the inset rim and band are drawn.
class PxWindow extends StatelessWidget {
  const PxWindow({super.key, required this.child, this.paper = Palette.cream50, this.border = 0, this.padding = EdgeInsets.zero, this.clip = false});
  final Widget child;
  final Color paper;
  final double border;
  final EdgeInsets padding;

  final bool clip;

  @override
  Widget build(BuildContext context) {
    Widget inner = Padding(padding: padding, child: child);
    if (clip) inner = ClipRect(child: inner);
    return CustomPaint(
      painter: _WindowPainter(paper, border),
      child: Padding(padding: EdgeInsets.all(border), child: inner),
    );
  }
}

class _WindowPainter extends CustomPainter {
  _WindowPainter(this.paper, this.border);
  final Color paper;
  final double border;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final p = Paint();
    canvas.drawRect(Rect.fromLTWH(2, 4, w, h), p..color = Palette.pxDrop);
    p.color = Palette.pxInk;
    canvas
      ..drawRect(Rect.fromLTWH(0, -2, w, 2), p)
      ..drawRect(Rect.fromLTWH(0, h, w, 2), p)
      ..drawRect(Rect.fromLTWH(-2, 0, 2, h), p)
      ..drawRect(Rect.fromLTWH(w, 0, 2, h), p);
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), p..color = paper);
    if (border > 0) {
      final b = Paint()
        ..color = Palette.bark900
        ..style = PaintingStyle.stroke
        ..strokeWidth = border;
      canvas.drawRect(Rect.fromLTWH(border / 2, border / 2, w - border, h - border), b);
    }
    final inner = Rect.fromLTWH(border, border, w - 2 * border, h - 2 * border);
    canvas.drawRect(Rect.fromLTWH(inner.left, inner.bottom - 4, inner.width, 4), p..color = Palette.cream300);
    final rim = Paint()
      ..color = Palette.rim
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRect(inner.deflate(1), rim);
  }

  @override
  bool shouldRepaint(_WindowPainter old) => old.paper != paper || old.border != border;
}

/// A foreground decoration, since an inset line takes no room from what is inside.
const pxRing = BoxDecoration(border: Border.fromBorderSide(BorderSide(color: Palette.cream300, width: 2)));

/// Unlike a LayoutBuilder it answers intrinsic sizes, so it may sit in an IntrinsicHeight.
class FillWidth extends SingleChildRenderObjectWidget {
  const FillWidth({super.key, super.child});

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderFillWidth();
}

class _RenderFillWidth extends RenderProxyBox {
  @override
  void performLayout() {
    final c = constraints;
    final child = this.child;
    if (child == null) {
      size = c.smallest;
      return;
    }
    child.layout(c.hasBoundedWidth ? c.tighten(width: c.maxWidth) : c, parentUsesSize: true);
    size = child.size;
  }
}

/// Its clip reaches past its box by a frame's outline (2 px) above and at the left and by its drop (2, 4) at the right and below, so a PxWindow laid at its
/// edge keeps its outline and drop.
class PxScrollView extends StatelessWidget {
  const PxScrollView({super.key, required this.child, this.padding, this.controller});
  final Widget child;
  final EdgeInsets? padding;
  final ScrollController? controller;

  @override
  Widget build(BuildContext context) => ClipRect(
    clipper: const _Bleed(),
    child: SingleChildScrollView(clipBehavior: Clip.none, controller: controller, padding: padding, child: child),
  );
}

class _Bleed extends CustomClipper<Rect> {
  const _Bleed();

  @override
  Rect getClip(Size size) => Rect.fromLTRB(-2, -2, size.width + 4, size.height + 6);

  @override
  bool shouldReclip(_Bleed old) => false;
}

class DashedLine extends StatelessWidget {
  const DashedLine({super.key, this.color = Palette.cream200, this.thickness = 2, this.vertical = false});
  final Color color;
  final double thickness;
  final bool vertical;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: vertical ? thickness : double.infinity,
    height: vertical ? double.infinity : thickness,
    child: CustomPaint(painter: _DashPainter(color, thickness, vertical)),
  );
}

class _DashPainter extends CustomPainter {
  _DashPainter(this.color, this.thickness, this.vertical);
  final Color color;
  final double thickness;
  final bool vertical;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color;
    final dash = thickness * 2;
    final length = vertical ? size.height : size.width;
    for (var at = 0.0; at < length; at += dash * 2) {
      final run = (length - at).clamp(0, dash).toDouble();
      canvas.drawRect(vertical ? Rect.fromLTWH(0, at, thickness, run) : Rect.fromLTWH(at, 0, run, thickness), p);
    }
  }

  @override
  bool shouldRepaint(_DashPainter old) => old.color != color || old.thickness != thickness || old.vertical != vertical;
}

/// Until the app sets it, a tap does nothing.
void Function(Uri uri)? kitOpenLink;

Color currentColor(BuildContext context) => DefaultTextStyle.of(context).style.color ?? Palette.bark900;
