import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import 'labels.dart';

/// Below this much left, the farm warns and the manager sends someone else if it can (protocol.QuotaLow).
const quotaLow = 15;

/// 0..100; null when the usage has no percentages.
String _money(String currency, double amount) =>
    '${currency == 'CNY'
        ? '¥'
        : currency == 'USD'
        ? r'$'
        : '$currency '}${amount.toStringAsFixed(2)}';

enum QuotaLevel { plenty, low, empty, unknown, gold }

QuotaLevel levelOf(double? left) => left == null
    ? QuotaLevel.unknown
    : left < quotaLow
    ? QuotaLevel.empty
    : left < 50
    ? QuotaLevel.low
    : QuotaLevel.plenty;

const _liquid = <QuotaLevel, (Color, Color)>{
  QuotaLevel.plenty: (Color(0xFFA6DC7C), Color(0xFF5F9A35)),
  QuotaLevel.low: (Color(0xFFFFD978), Color(0xFFE39A32)),
  QuotaLevel.empty: (Color(0xFFFF9A80), Color(0xFFCC4B3A)),
  QuotaLevel.unknown: (Color(0xFFE6DCC8), Color(0xFFC9BDA4)),
  QuotaLevel.gold: (Color(0xFFFFE9A3), Color(0xFFDFA63A)),
};

/// Runtimes name their windows in English; the common ones read better in Chinese.
String windowLabel(String label) {
  if (label == 'Current session') return '当前会话';
  if (label == 'Weekly included usage') return '本周额度';
  final week = RegExp(r'^Current week \((.+)\)$').firstMatch(label);
  if (week != null) return '本周（${week[1] == 'all models' ? '全部模型' : week[1]}）';
  return label.replaceFirst(RegExp(r'·\s*1 week'), '· 一周');
}

class Quota {
  const Quota({required this.level, required this.fill, required this.short, required this.text});
  final QuotaLevel level;
  final double fill;
  final String short;
  final String text;
}

/// The bottle for a runtime: how full and in what colour from its usage, what is left and the words from the server
/// (RuntimeInfo.quota).
Quota quotaOf(RuntimeInfo? info) {
  final usage = info?.usage;
  final text = info?.quota?.text ?? '不报额度';
  // Not logged in: nothing to work with, which is an empty bottle, not an unknown one.
  if (usage is AccountUsageLoginRequired) return Quota(level: QuotaLevel.empty, fill: 0, short: '没登录', text: text);
  if (usage is AccountUsageBalance) {
    final first = usage.balances.firstOrNull;
    return Quota(
      level: usage.available ? QuotaLevel.gold : QuotaLevel.empty,
      fill: usage.available ? 1 : 0.06,
      short: first != null ? _money(first.currency, first.amount) : '',
      text: text,
    );
  }
  final left = info?.quota?.left;
  return Quota(level: levelOf(left), fill: left == null ? 0 : left / 100, short: left == null ? '' : '${numberText(left)}%', text: text);
}

String bottleSprite(Quota q) => switch (q.level) {
  QuotaLevel.plenty =>
    q.fill >= 0.875
        ? 'energy-plenty-100'
        : q.fill >= 0.625
        ? 'energy-plenty-75'
        : 'energy-plenty-50',
  QuotaLevel.low => q.fill >= 0.325 ? 'energy-low-40' : 'energy-low-25',
  QuotaLevel.empty => q.fill > 0.02 ? 'energy-empty-10' : 'energy-empty-0',
  QuotaLevel.unknown => 'energy-unknown',
  QuotaLevel.gold => 'energy-gold',
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
