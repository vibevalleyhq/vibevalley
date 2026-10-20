import '../gen/vibevalley.dart';
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
