// Ported from web/src/farm/Quota.tsx: which runtimes' accounts the farm watches (its `runtimes` filter) and when a plan
// window resets, in words (resetText). The pill in the village HUD and the desk's quota panel both read these.

import '../gen/vibevalley.dart';

const _weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/// 「3 小时后重置」「周四重置」; `now` is for tests.
String resetText(double at, {DateTime? now}) {
  final ms = at - (now ?? DateTime.now()).millisecondsSinceEpoch;
  if (ms <= 0) return '马上重置';
  final hours = ms / 3600000;
  if (hours < 1) return '${(ms / 60000).round().clamp(1, 60)} 分钟后重置';
  if (hours < 24) return '${hours.round()} 小时后重置';
  return '${_weekday[DateTime.fromMillisecondsSinceEpoch(at.round()).weekday - 1]}重置';
}

/// The runtimes helpers may use: a switched-off one's account is not the farm's business.
List<RuntimeInfo> usableRuntimes(List<RuntimeInfo> all) => [
  for (final r in all)
    if (r.installation is InstallationAvailable && r.settings.enabled) r,
];
