import '../gen/vibevalley.dart';

const _weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

String resetText(double at, {DateTime? now}) {
  final ms = at - (now ?? DateTime.now()).millisecondsSinceEpoch;
  if (ms <= 0) return '马上重置';
  final hours = ms / 3600000;
  if (hours < 1) return '${(ms / 60000).round().clamp(1, 60)} 分钟后重置';
  if (hours < 24) return '${hours.round()} 小时后重置';
  return '${_weekday[DateTime.fromMillisecondsSinceEpoch(at.round()).weekday - 1]}重置';
}

/// A switched-off runtime's account is not the farm's business.
List<RuntimeInfo> usableRuntimes(List<RuntimeInfo> all) => [
  for (final r in all)
    if (r.installation is InstallationAvailable && r.settings.enabled) r,
];
