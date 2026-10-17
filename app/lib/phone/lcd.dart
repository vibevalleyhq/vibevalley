import 'package:flutter/painting.dart';

import '../ui/theme.dart';

abstract final class Lcd {
  static const paper = Color(0xFFC9DC9A);
  static const light = Color(0xFFB9CF8C);
  static const mid = Color(0xFF6F8F45);
  static const dark = Color(0xFF3D5A2A);
  static const ink = Color(0xFF22341A);

  static const pale = Color(0xFFE8F0C8);
  static const paleHover = Color(0xFFF2F7DC);

  static const rule = Color(0xFF9FB07A);
}

TextStyle lcdText({double size = 12, Color color = Lcd.ink, double height = 1.5}) =>
    TextStyle(fontFamily: pixelFont, fontSize: size, height: height, color: color, fontFeatures: const [FontFeature.tabularFigures()]);

void drawPattern(Canvas canvas, List<String> rows, double x, double y) {
  final paint = Paint()..isAntiAlias = false;
  final ox = x.roundToDouble();
  final oy = y.roundToDouble();
  for (var dy = 0; dy < rows.length; dy++) {
    final row = rows[dy];
    for (var dx = 0; dx < row.length; dx++) {
      final c = switch (row[dx]) {
        '#' => Lcd.ink,
        '+' => Lcd.dark,
        '.' => Lcd.light,
        _ => null,
      };
      if (c == null) continue;
      canvas.drawRect(Rect.fromLTWH(ox + dx, oy + dy, 1, 1), paint..color = c);
    }
  }
}
