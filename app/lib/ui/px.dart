// The pixel skin's frames and faces (web/src/index.css :root[data-skin='pixel'], web/src/farm/Face.tsx):
//   PxFrame  a window: a light rim inside, a deeper band along its bottom, a 2 px dark outline with the corners left
//            out, and a hard drop down and right (--px-frame)
//   PxInset  a well or chip inside a frame: a 2 px line of the paper's darker shade (--px-inset)
//   ManagerFace, AnimalFace  the manager's face, and a helper's head cut from its full-body drawing

import 'package:flutter/widgets.dart';

import '../app/theme.dart';
import '../sprites/atlas.dart';

class PxFrame extends StatelessWidget {
  const PxFrame({super.key, required this.child, this.paper = Palette.cream50, this.padding = EdgeInsets.zero});
  final Widget child;
  final Color paper;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _FramePainter(paper),
    child: Padding(padding: padding + const EdgeInsets.all(2), child: child),
  );
}

class _FramePainter extends CustomPainter {
  _FramePainter(this.paper);
  final Color paper;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final p = Paint();
    // The drop, behind: the box moved 2 right and 4 down.
    canvas.drawRect(Rect.fromLTWH(2, 4, w, h), p..color = Palette.pxDrop);
    // The outline on each side, corners left out.
    p.color = Palette.pxInk;
    canvas
      ..drawRect(Rect.fromLTWH(0, -2, w, 2), p)
      ..drawRect(Rect.fromLTWH(0, h, w, 2), p)
      ..drawRect(Rect.fromLTWH(-2, 0, 2, h), p)
      ..drawRect(Rect.fromLTWH(w, 0, 2, h), p);
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), p..color = paper);
    // The deeper band along the bottom, then the light rim all round.
    canvas.drawRect(Rect.fromLTWH(0, h - 4, w, 4), p..color = Palette.cream300);
    final rim = Paint()
      ..color = Palette.rim
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRect(Rect.fromLTWH(1, 1, w - 2, h - 2), rim);
  }

  @override
  bool shouldRepaint(_FramePainter old) => old.paper != paper;
}

/// A well or chip: the paper with a 2 px inner line of its darker shade.
BoxDecoration pxInset({Color fill = Palette.cream200, Color line = Palette.cream300}) => BoxDecoration(
  color: fill,
  border: Border.all(color: line, width: 2),
);

/// A hard 2 px drop under something raised (a button, a bubble of yours).
const pxDropShadow = [BoxShadow(color: Palette.pxDrop, offset: Offset(2, 2))];

/// The manager's face on its sky-blue square (Face.tsx ManagerFace); another portrait the same way with `look` and
/// `fill` (the owner's, on wheat).
class ManagerFace extends StatelessWidget {
  const ManagerFace({super.key, required this.atlas, required this.size, this.look = 'manager-face', this.fill = const Color(0xFFCFE6F5)});
  final SpriteAtlas atlas;
  final double size;
  final String look;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    final sp = atlas.has(look) ? atlas[look] : atlas['manager-face'];
    final k = size / (sp.w * 0.86);
    return SizedBox.square(
      dimension: size,
      child: ClipRect(
        child: ColoredBox(
          color: fill,
          child: Stack(
            children: [
              Positioned(
                left: (size - sp.w * k) / 2,
                top: size * 0.04,
                width: sp.w * k,
                height: sp.h * k,
                child: Image.asset(sp.asset, filterQuality: FilterQuality.none, fit: BoxFit.fill),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A helper's face: its head, cut from its standing drawing (`look`-down), on a leaf-green square (Face.tsx AnimalFace).
class AnimalFace extends StatelessWidget {
  const AnimalFace({super.key, required this.atlas, required this.look, required this.size});
  final SpriteAtlas atlas;
  final String look;
  final double size;

  @override
  Widget build(BuildContext context) {
    final sp = atlas.has('$look-down') ? atlas['$look-down'] : atlas['bear-farmer-down'];
    final k = size / (sp.h * 0.5);
    final cx = sp.w / 2;
    final cy = sp.h * 0.25 + sp.h * 0.03;
    return SizedBox.square(
      dimension: size,
      child: ClipRect(
        child: ColoredBox(
          color: Palette.leaf300.withValues(alpha: 0.6),
          child: Stack(
            clipBehavior: Clip.hardEdge,
            children: [
              Positioned(
                left: size / 2 - cx * k,
                top: size / 2 - cy * k,
                width: sp.w * k,
                height: sp.h * k,
                child: Image.asset(sp.asset, filterQuality: FilterQuality.none, fit: BoxFit.fill),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
