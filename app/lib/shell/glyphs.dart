import 'package:flutter/widgets.dart';

class PixelMark extends StatelessWidget {
  const PixelMark(this.cells, {super.key, required this.size, required this.color, this.grid = 7});

  const PixelMark.tick({super.key, required this.size, required this.color}) : cells = const [(6, 1), (5, 2), (4, 3), (0, 3), (1, 4), (3, 4), (2, 5)], grid = 7;

  const PixelMark.cross({super.key, required this.size, required this.color})
    : cells = const [(1, 1), (5, 1), (2, 2), (4, 2), (3, 3), (2, 4), (4, 4), (1, 5), (5, 5)],
      grid = 7;

  final List<(int, int)> cells;
  final double size;
  final Color color;
  final int grid;

  @override
  Widget build(BuildContext context) => CustomPaint(size: Size.square(size), painter: _MarkPainter(cells, color, grid));
}

class _MarkPainter extends CustomPainter {
  _MarkPainter(this.cells, this.color, this.grid);
  final List<(int, int)> cells;
  final Color color;
  final int grid;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / grid;
    final paint = Paint()
      ..color = color
      ..isAntiAlias = false;
    for (final (x, y) in cells) {
      canvas.drawRect(Rect.fromLTWH(x * cell, y * cell, cell, cell), paint);
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.color != color || old.cells != cells;
}
