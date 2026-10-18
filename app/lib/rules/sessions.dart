// The server folds the state; these only read it.

import 'dart:math' as math;

import '../gen/vibevalley.dart';

/// A plot is an issue being worked: the farm view keys it by the issue (protocol.PlotKey; keep the two the same).
String plotKey(Session h) => (h.issue ?? '').isNotEmpty ? h.issue! : h.id;

bool isBusy(Session h) => h.phase is PhaseArriving || h.phase is PhaseWorking;

const _nothing = Doing(action: SessionAction.none, label: '');

Doing doingOf(Session h) => switch (h.phase) {
  PhaseWorking(:final doing) => doing,
  _ => _nothing,
};

/// A stopped turn may have work too.
bool canHarvest(Session h) => h.phase is PhaseRipe || h.phase is PhaseResting;

String _span(double ms) => ms < 60000 ? '${math.max(1, (ms / 1000).round())} 秒' : '${(ms / 60000).round()} 分钟';

/// The server's words for what the session is doing (Session.phaseText), how long it has been quiet filled in by the clock.
String phaseText(Session h, double now) {
  final words = h.phaseText ?? '';
  final phase = h.phase;
  return phase is PhaseWorking && phase.quietSince != null ? words.replaceAll('{span}', _span(now - phase.quietSince!)) : words;
}
