// The words for states, in site language (web/src/ui/labels.ts).

import '../../gen/vibevalley.dart';

/// What the robot is doing, in site language. The real detail (path, command) is shown next to it.
const actionLabel = <WorkerAction, String>{
  WorkerAction.runCommand: '打桩',
  WorkerAction.readFile: '看图纸',
  WorkerAction.editFile: '砌砖',
  WorkerAction.search: '翻材料',
  WorkerAction.web: '收信号',
  WorkerAction.mcp: '拧扳手',
  WorkerAction.wait: '歇口气',
  WorkerAction.other: '忙活',
  WorkerAction.thinking: '琢磨',
  WorkerAction.speakingText: '写报告',
  WorkerAction.none: '',
};

/// What the action means for the code, for the roster and the detail dialog.
const actionMeaning = <WorkerAction, String>{
  WorkerAction.runCommand: '跑命令',
  WorkerAction.readFile: '读文件',
  WorkerAction.editFile: '改文件',
  WorkerAction.search: '搜索',
  WorkerAction.web: '查网页',
  WorkerAction.mcp: '调 MCP 工具',
  WorkerAction.wait: '等待',
  WorkerAction.other: '其他工具',
  WorkerAction.thinking: '思考',
  WorkerAction.speakingText: '输出文字',
  WorkerAction.none: '—',
};

/// A helper's phase, in a word (PHASE_LABEL).
String phaseLabel(Phase phase) => switch (phase) {
  PhaseArriving() => '进场',
  PhaseWorking() => '干活中',
  PhaseRipe() => '完工',
  PhaseFailed() => '出故障',
  PhaseResting() => '歇着',
};

const foremanLabel = <ForemanState, String>{ForemanState.idle: '没开工', ForemanState.listening: '在听', ForemanState.thinking: '在想', ForemanState.speaking: '在说'};

const outcomeLabel = <Outcome, String>{Outcome.completed: '完成', Outcome.failed: '失败', Outcome.interrupted: '叫停'};

const runtimeLabel = <String, String>{'claude': 'Claude', 'codex': 'Codex'};

/// How long ago `at` was, at `now` (both epoch milliseconds): seconds, minutes, then hours and days (the web page,
/// frozen, says minutes all the way).
String ago(num at, num now) {
  final r = ((now - at) / 1000).round();
  final s = r < 0 ? 0 : r;
  if (s < 5) return '刚刚';
  if (s < 60) return '$s 秒前';
  if (s < 3600) return '${(s / 60).round()} 分钟前';
  if (s < 86400) return '${s ~/ 3600} 小时前';
  return '${s ~/ 86400} 天前';
}
