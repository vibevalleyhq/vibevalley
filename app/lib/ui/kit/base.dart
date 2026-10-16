// What the kit's widgets share, as the page's pixel skin draws it (web/src/index.css :root[data-skin='pixel']):
//   KitText      the type scale: the font is drawn on a 12-pixel grid, so text-xs/sm/base are 12 px and lg/xl 24 px;
//                one weight (the skin forces 400 and turns synthesis off, so bold and italic draw plain)
//   KitTappable  hover, press and keyboard focus (focus-visible) for anything clickable, Enter and Space included
//   PxWindow     --px-frame on a box with an optional border: the light rim and the deeper bottom band inside, a 2 px
//                outline with the corners left out and a hard drop (2, 4) outside
//   DashedLine   a dashed rule (border-dashed)
//   PxScrollView a scroll view that lets the frames at its edges show whole: their outlines and drops paint outside
//                their boxes, where a plain scroll view would cut them
//
// Two quirks of the skin that the kit reproduces on purpose: every class with "shadow" in it becomes a hard 2 px drop,
// and every class with "ring-2" (focus rings included, focused or not) becomes a 2 px cream-300 inner line, so focus
// rings never show; only `outline` (the button's focus ring) and an input's border colour mark focus.

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../app/theme.dart';

/// The type scale. Line heights are Tailwind's for each size (the skin changes the size, not the line height).
abstract final class KitText {
  /// text-xs (and text-[11px]): 12 px, line height 1rem/0.75rem.
  static const xs = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-[11px] and text-[10px] where no ancestor sets a size: 12 px, and the line height the page's body gives
  /// (1.5), since an arbitrary size sets none of its own. Under a text-xs or text-sm parent they take its ratio.
  static const fine = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.5, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-sm: 12 px, line height 1.25rem/0.875rem.
  static const sm = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 20 / 14, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-base: 12 px, line height 1.5.
  static const base = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.5, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-lg: 24 px.
  static const lg = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 18, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-xl: 24 px.
  static const xl = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// text-2xl: 24 px.
  static const x2l = TextStyle(fontFamily: pixelFont, fontSize: 24, height: 32 / 24, fontWeight: FontWeight.w400, color: Palette.bark900);

  /// font-mono at text-xs.
  static const mono = TextStyle(fontFamily: monoFont, fontFamilyFallback: monoFallback, fontSize: 12, height: 4 / 3, color: Palette.bark900);
}

/// How long a transition takes: `d`, or none when the system asks for less motion (macOS's Reduce motion).
Duration kitMotion(BuildContext context, Duration d) => (MediaQuery.maybeDisableAnimationsOf(context) ?? false) ? Duration.zero : d;

/// Whether looping motion (a bob, a blink) should run: not when the system asks for less motion.
bool kitMoves(BuildContext context) => !(MediaQuery.maybeDisableAnimationsOf(context) ?? false);

/// The hard drop under raised things (--px-drop, 2 px down and right).
const kitDrop = [BoxShadow(color: Palette.pxDrop, offset: Offset(2, 2))];

/// What a clickable thing is going through.
class KitState {
  const KitState({required this.enabled, required this.hovered, required this.pressed, required this.focused});
  final bool enabled;
  final bool hovered;
  final bool pressed;

  /// Focused from the keyboard (focus-visible), not by a click.
  final bool focused;
}

/// Anything clickable: hover, press, keyboard focus, Enter and Space, a tooltip (the page's `title`) and its semantics.
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

/// A box worn with --px-frame (role=dialog, .farm-card, popups): `border` (0 or 2) is a CSS border inside the frame,
/// in bark-900, under which the inset rim and band are drawn.
class PxWindow extends StatelessWidget {
  const PxWindow({super.key, required this.child, this.paper = Palette.cream50, this.border = 0, this.padding = EdgeInsets.zero, this.clip = false});
  final Widget child;
  final Color paper;
  final double border;
  final EdgeInsets padding;

  /// overflow-hidden: children are clipped to the paper.
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

/// The skin's inner line (`ring-1`, `ring-2` and `shadow-[inset…]` all become it): 2 px of cream-300 inside the box,
/// as a foreground decoration, since an inset box-shadow takes no room from what is inside.
const pxRing = BoxDecoration(border: Border.fromBorderSide(BorderSide(color: Palette.cream300, width: 2)));

/// A block box: as wide as the width it is given when that is bounded (a div in a column), else as wide as its child.
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

/// A scroll view whose clip reaches past its box by a frame's outline (2 px) above and at the left and by its drop
/// (2, 4) at the right and below, so a PxWindow laid at its edge keeps its outline and drop, as on the page, where the
/// frame's box-shadow is cut only by a scrolling ancestor.
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

/// A dashed rule, `thickness` thick: dashes as long as twice the thickness, as browsers draw border-dashed.
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

/// Where a link in markdown goes when tapped (the page opens it in a new tab). The app sets this once, e.g. to
/// url_launcher's launchUrl; until then a tap does nothing.
void Function(Uri uri)? kitOpenLink;

/// The colour of the text around `context` (the page's currentColor).
Color currentColor(BuildContext context) => DefaultTextStyle.of(context).style.color ?? Palette.bark900;
