import '../../gen/vibevalley.dart';

String phaseLabel(Phase phase) => switch (phase) {
  PhaseArriving() => '进场',
  PhaseWorking() => '干活中',
  PhaseRipe() => '完工',
  PhaseFailed() => '出故障',
  PhaseResting() => '歇着',
  PhaseClosed(:final closed) => switch (closed) {
    IssueClose.merged => '收获了',
    IssueClose.mergedIntoPlan => '合进计划了',
    IssueClose.dismissed => '收工了',
    IssueClose.lost => '目录丢了',
    IssueClose.answered => '答完了',
  },
};

const managerLabel = <ManagerState, String>{ManagerState.idle: '没开工', ManagerState.listening: '在听', ManagerState.thinking: '在想', ManagerState.speaking: '在说'};

const outcomeLabel = <Outcome, String>{Outcome.completed: '完成', Outcome.failed: '失败', Outcome.interrupted: '叫停'};

const runtimeLabel = <String, String>{'claude': 'Claude', 'codex': 'Codex'};

String ago(num at, num now) {
  final r = ((now - at) / 1000).round();
  final s = r < 0 ? 0 : r;
  if (s < 5) return '刚刚';
  if (s < 60) return '$s 秒前';
  if (s < 3600) return '${(s / 60).round()} 分钟前';
  if (s < 86400) return '${s ~/ 3600} 小时前';
  return '${s ~/ 86400} 天前';
}

/// A whole number without its .0, as the server writes ids and counts.
String numberText(num v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();
