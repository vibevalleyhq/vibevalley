import 'package:flutter/widgets.dart';
import '../common.dart';

export '../faces.dart';

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
    canvas.drawRect(Rect.fromLTWH(2, 4, w, h), p..color = Palette.pxDrop);
    p.color = Palette.pxInk;
    canvas
      ..drawRect(Rect.fromLTWH(0, -2, w, 2), p)
      ..drawRect(Rect.fromLTWH(0, h, w, 2), p)
      ..drawRect(Rect.fromLTWH(-2, 0, 2, h), p)
      ..drawRect(Rect.fromLTWH(w, 0, 2, h), p);
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), p..color = paper);
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

BoxDecoration pxInset({Color fill = Palette.cream200, Color line = Palette.cream300}) => BoxDecoration(
  color: fill,
  border: Border.all(color: line, width: 2),
);
