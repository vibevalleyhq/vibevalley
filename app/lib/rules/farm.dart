// The server folds the state; these only read it.

import 'dart:math' as math;

import '../gen/vibevalley.dart';

bool isBusy(Worker h) => h.phase is PhaseArriving || h.phase is PhaseWorking;

const _nothing = Doing(action: WorkerAction.none, label: '');

Doing doingOf(Worker h) => switch (h.phase) {
  PhaseWorking(:final doing) => doing,
  _ => _nothing,
};

/// A stopped turn may have work too.
bool canHarvest(Worker h) => h.phase is PhaseRipe || h.phase is PhaseResting;

String _span(double ms) => ms < 60000 ? '${math.max(1, (ms / 1000).round())} 秒' : '${(ms / 60000).round()} 分钟';

/// The server's words for what the worker is doing (Worker.phaseText), how long it has been quiet filled in by the clock.
String phaseText(Worker h, double now) {
  final words = h.phaseText ?? '';
  final phase = h.phase;
  return phase is PhaseWorking && phase.quietSince != null ? words.replaceAll('{span}', _span(now - phase.quietSince!)) : words;
}
