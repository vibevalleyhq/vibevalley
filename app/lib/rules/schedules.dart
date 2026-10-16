// Ported from packages/protocol/src/schedules.ts: a schedule in words (whenText), when it is next due (nextRun) and that
// in words (nextText).

import '../gen/vibevalley.dart';

const _weekdays = ['日', '一', '二', '三', '四', '五', '六'];
String _two(int n) => n.toString().padLeft(2, '0');

/// 10/13 09:00. The schedule's time zone is read as this machine's: Dart has no time-zone database, and the server
/// runs on the same machine, so the two agree unless a schedule was made for another zone.
String _clock(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.month}/${d.day} ${_two(d.hour)}:${_two(d.minute)}';
}

/// When, in words: 每天 09:00, 每周一、三 09:00, 每 30 分钟, 10/13 09:00 一次 (protocol whenText).
String whenText(ScheduleWhen when, String tz) => switch (when) {
  ScheduleWhenOnce(:final at) => '${_clock(at)} 一次',
  ScheduleWhenEvery(:final minutes) => minutes % 60 == 0 ? '每 ${_n(minutes / 60)} 小时' : '每 ${_n(minutes)} 分钟',
  ScheduleWhenDaily(:final time) => '每天 $time',
  ScheduleWhenWeekly(:final days, :final time) =>
    '每周${({for (final d in days) d.toInt()}.toList()..sort()).map((d) => d >= 0 && d < 7 ? _weekdays[d] : '$d').join('、')} $time',
};

final _time = RegExp(r'^([01]?\d|2[0-3]):([0-5]\d)$');

/// The first minute after `from` at `time` on one of `days` (0 is Sunday; all when null), in local time: Effect's
/// Cron.next for `m h * * days`.
double? _cronNext(String time, List<double>? days, double from) {
  final m = _time.firstMatch(time);
  if (m == null) return null;
  final hour = int.parse(m.group(1)!), minute = int.parse(m.group(2)!);
  final start = DateTime.fromMillisecondsSinceEpoch(from.floor());
  final allowed = days == null || days.isEmpty ? null : {for (final d in days) d.toInt()};
  for (var i = 0; i <= 8; i++) {
    final at = DateTime(start.year, start.month, start.day + i, hour, minute);
    if (!at.isAfter(start)) continue;
    if (allowed != null && !allowed.contains(at.weekday % 7)) continue;
    return at.millisecondsSinceEpoch.toDouble();
  }
  return null;
}

/// When it is next due, from its last run (or its making); null when it is off or done (protocol nextRun).
double? nextRun(FarmSchedule s) {
  if (!s.enabled) return null;
  final from = s.lastRun ?? s.created;
  return switch (s.when) {
    ScheduleWhenOnce(:final at) => s.lastRun == null ? at : null,
    ScheduleWhenEvery(:final minutes) => from + minutes * 60000,
    ScheduleWhenDaily(:final time) => _cronNext(time, null, from),
    ScheduleWhenWeekly(:final days, :final time) => _cronNext(time, days, from),
  };
}

/// The next run in words, or why there is none (protocol nextText).
String nextText(FarmSchedule s) {
  final next = nextRun(s);
  if (next != null) return _clock(next);
  if (s.enabled) return '不会再到点';
  return s.when is ScheduleWhenOnce && s.lastRun != null ? '做过了' : '关着';
}

/// A number as the page writes it: 7, not 7.0.
String _n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();
