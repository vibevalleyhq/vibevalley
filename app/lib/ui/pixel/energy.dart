import 'dart:math' as math;
import 'package:flutter/widgets.dart';
import '../../sprites/atlas.dart';
import '../common.dart';

export '../quota.dart';

const _liquid = <QuotaLevel, (Color, Color)>{
  QuotaLevel.plenty: (Color(0xFFA6DC7C), Color(0xFF5F9A35)),
  QuotaLevel.low: (Color(0xFFFFD978), Color(0xFFE39A32)),
  QuotaLevel.empty: (Color(0xFFFF9A80), Color(0xFFCC4B3A)),
  QuotaLevel.unknown: (Color(0xFFE6DCC8), Color(0xFFC9BDA4)),
  QuotaLevel.gold: (Color(0xFFFFE9A3), Color(0xFFDFA63A)),
};

/// Shown at a whole multiple of 24 art pixels, the nearest to `size`.
const _pixelBottle = 24;

class EnergyBottle extends StatelessWidget {
  const EnergyBottle({super.key, required this.atlas, required this.quota, this.size = 28});
  final SpriteAtlas atlas;
  final Quota quota;
  final double size;

  @override
  Widget build(BuildContext context) {
    final bottle = atlas[bottleSprite(quota)];
    final scale = math.max(1, (size / _pixelBottle).round()).toDouble();
    return Semantics(
      image: true,
      label: quota.text,
      child: ExcludeSemantics(child: PixelSprite(bottle, scale: scale)),
    );
  }
}

/// At least one segment is lit when anything is left.
class StaminaBar extends StatelessWidget {
  const StaminaBar({super.key, required this.quota, this.segments = 10, this.width = 64, this.height = 8});
  final Quota quota;
  final int segments;
  final double width;
  final double height;

  static int litOf(Quota q, int segments) => q.fill <= 0 ? 0 : math.max(1, (q.fill * segments).round());

  @override
  Widget build(BuildContext context) => Semantics(
    image: true,
    label: quota.text,
    child: SizedBox(
      width: width,
      height: height,
      child: CustomPaint(painter: _BarPainter(_liquid[quota.level]!, segments, litOf(quota, segments))),
    ),
  );
}

class _BarPainter extends CustomPainter {
  _BarPainter(this.liquid, this.segments, this.lit);
  final (Color, Color) liquid;
  final int segments;
  final int lit;

  @override
  void paint(Canvas canvas, Size size) {
    const pad = 1.5;
    const gap = 1.5;
    canvas.drawRect(Rect.fromLTWH(2, 2, size.width, size.height), Paint()..color = const Color(0x731E140A));
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF46301D));
    final w = (size.width - 2 * pad - gap * (segments - 1)) / segments;
    final h = size.height - 2 * pad;
    final (light, dark) = liquid;
    for (var i = 0; i < segments; i++) {
      final r = Rect.fromLTWH(pad + i * (w + gap), pad, w, h);
      final p = Paint();
      if (i < lit) {
        p.shader = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [light, dark]).createShader(r);
      } else {
        p.color = const Color(0x2EFFFDF6);
      }
      canvas.drawRect(r, p);
    }
  }

  @override
  bool shouldRepaint(_BarPainter old) => old.liquid != liquid || old.segments != segments || old.lit != lit;
}
