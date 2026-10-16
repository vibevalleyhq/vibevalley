// The server folds the state; these only read it.

import 'dart:math' as math;

import '../gen/vibevalley.dart';

bool isBusy(Helper h) => h.phase is PhaseArriving || h.phase is PhaseWorking;

const _nothing = Doing(action: WorkerAction.none, label: '');

Doing doingOf(Helper h) => switch (h.phase) {
  PhaseWorking(:final doing) => doing,
  _ => _nothing,
};

/// A stopped turn may have work too.
bool canHarvest(Helper h) => h.phase is PhaseRipe || h.phase is PhaseResting;

sealed class Need {
  const Need();
}

final class NeedConflict extends Need {
  const NeedConflict(this.conflict);
  final Conflict conflict;
}

final class NeedHarvest extends Need {
  const NeedHarvest();
}

final class NeedFix extends Need {
  const NeedFix();
}

final class NeedQuiet extends Need {
  const NeedQuiet(this.since);
  final double since;
}

final class NeedRetrying extends Need {
  const NeedRetrying(this.attempt, this.of);
  final double attempt;
  final double? of;
}

Need? needOf(Helper h) => switch (h.phase) {
  PhaseWorking(:final quietSince, :final retry) =>
    quietSince != null
        ? NeedQuiet(quietSince)
        : retry != null
        ? NeedRetrying(retry.attempt, retry.of)
        : null,
  PhaseRipe() => h.conflict != null ? NeedConflict(h.conflict!) : const NeedHarvest(),
  PhaseFailed() => const NeedFix(),
  PhaseResting() => h.conflict != null ? NeedConflict(h.conflict!) : null,
  PhaseArriving() => null,
};

const actionText = {
  WorkerAction.runCommand: '跑命令',
  WorkerAction.readFile: '读文件',
  WorkerAction.editFile: '改文件',
  WorkerAction.search: '搜索',
  WorkerAction.web: '查网页',
  WorkerAction.mcp: '调 MCP 工具',
  WorkerAction.wait: '等待',
  WorkerAction.other: '用工具',
  WorkerAction.thinking: '思考',
  WorkerAction.speakingText: '写汇报',
  WorkerAction.none: '',
};

String _span(double ms) => ms < 60000 ? '${math.max(1, (ms / 1000).round())} 秒' : '${(ms / 60000).round()} 分钟';

/// 7, not 7.0.
String _n(double v) => v == v.roundToDouble() ? '${v.toInt()}' : '$v';

/// A retry's `of` of 0 is left out.
String phaseText(Helper h, double now) {
  final need = needOf(h);
  final conflict = need is NeedConflict ? '，合进 ${need.conflict.base} 会冲突（${need.conflict.files.join('、')}）' : '';
  switch (h.phase) {
    case PhaseArriving():
      return '刚派出去，正在开工';
    case PhaseWorking(:final doing):
      final what = '在${actionText[doing.action]}${doing.label.isNotEmpty ? '：${doing.label}' : ''}';
      if (need is NeedQuiet) return '$what（已经 ${_span(now - need.since)}没动静了）';
      if (need is NeedRetrying) return '$what（模型调用失败，在重试第 ${_n(need.attempt)}${need.of != null && need.of != 0 ? '/${_n(need.of!)}' : ''} 次）';
      return what;
    case PhaseRipe():
      return '这一轮做完了，等收获$conflict';
    case PhaseFailed():
      return '这一轮失败了';
    case PhaseResting():
      final last = h.last;
      final was = last == null
          ? '没做完'
          : switch (last.outcome) {
              Outcome.interrupted => '被叫停',
              Outcome.completed => '做完了',
              Outcome.failed => '失败了',
            };
      return '歇着（上一轮$was）$conflict';
  }
}
