// Quota as the farm draws it (web/src/ui/Energy.tsx). Each runtime has an energy potion (精力瓶): the liquid is how much
// is left of its tightest window, green while there is plenty, amber when it runs low, red near empty; gold for
// pay-as-you-go (pi), where what is left is money, not a percentage. A stamina bar (体力条) of segments shows one
// window, and sits under every helper of that runtime.
//
// quotaLeft, quotaText and QUOTA_LOW are ports of packages/protocol (src/index.ts): the frame's view does not carry
// them. The page's useQuota(runtime) reads the client's config; here the caller finds the runtime's usage
// (RuntimeInfo.usage) and calls quotaOf.

import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';

/// Below this much left, the farm warns and the manager sends someone else if it can (protocol QUOTA_LOW).
const quotaLow = 15;

/// The tightest window's remaining percent, 0..100; null when the usage has no percentages (protocol quotaLeft).
double? quotaLeft(AccountUsage? usage) {
  if (usage is! AccountUsageOk || usage.windows.isEmpty) return null;
  return math.max(0, usage.windows.map((w) => 100 - w.usedPercent).reduce(math.min));
}

String _money(String currency, double amount) =>
    '${currency == 'CNY'
        ? '¥'
        : currency == 'USD'
        ? r'$'
        : '$currency '}${amount.toStringAsFixed(2)}';

/// The way JavaScript prints a number: no ".0" on whole ones.
String _num(double n) => n == n.roundToDouble() ? n.toInt().toString() : n.toString();

/// What is left, in a few words: for the manager and for tooltips (protocol quotaText).
String quotaText(AccountUsage? usage) => switch (usage) {
  null => '不报额度',
  AccountUsageLoginRequired() => '没登录',
  AccountUsageUnavailable(:final reason) => '读不到额度（$reason）',
  AccountUsageBalance(:final provider, :final available, :final balances) =>
    balances.isNotEmpty ? '$provider 余额 ${balances.map((b) => _money(b.currency, b.amount)).join('、')}${available ? '' : '，不够用了'}' : '$provider 读不到余额',
  AccountUsageOk(:final plan, :final windows) =>
    windows.isNotEmpty ? windows.map((w) => '${w.label} 剩 ${_num(100 - w.usedPercent)}%').join('，') : (plan ?? '有额度'),
};

enum QuotaLevel { plenty, low, empty, unknown, gold }

QuotaLevel levelOf(double? left) => left == null
    ? QuotaLevel.unknown
    : left < quotaLow
    ? QuotaLevel.empty
    : left < 50
    ? QuotaLevel.low
    : QuotaLevel.plenty;

/// Light and dark of each liquid, top to bottom.
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

/// What a runtime has left, for drawing: the level, how full (0..1), the short words ("89%", "¥470.88", or empty when
/// unknown) and the long ones.
class Quota {
  const Quota({required this.level, required this.fill, required this.short, required this.text});
  final QuotaLevel level;
  final double fill;
  final String short;
  final String text;
}

Quota quotaOf(AccountUsage? usage) {
  final text = quotaText(usage);
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
  final left = quotaLeft(usage);
  return Quota(level: levelOf(left), fill: left == null ? 0 : left / 100, short: left == null ? '' : '${_num(left)}%', text: text);
}

/// The bottle for a quota: its level, and how full in steps.
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

/// The pixel bottles are 24 art pixels tall: shown at a whole multiple of that, the nearest to `size`.
const _pixelBottle = 24;

/// Replaces web/src/ui/Energy.tsx EnergyBottle: a corked potion bottle filled to `quota.fill` in steps, at a whole
/// scale; its words are the tooltip-ready `quota.text` (semantics).
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

/// Replaces web/src/ui/Energy.tsx StaminaBar: a segmented bar, `quota.fill` of the way lit (at least one segment when
/// anything is left), in the level's liquid.
class StaminaBar extends StatelessWidget {
  const StaminaBar({super.key, required this.quota, this.segments = 10, this.width = 64, this.height = 8});
  final Quota quota;
  final int segments;
  final double width;
  final double height;

  /// How many segments are lit.
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
    // The skin turns the bar's soft shadow into a hard 2 px drop.
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
