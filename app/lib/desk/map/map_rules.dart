// The room is the project's slots less its working helpers, as far as the farm's beds go. It only decides how many empty plots
// are drawn; whether work may start is the server's (noRoom in server/internal/session/rules.go), and the two must agree.

import 'dart:math' as math;
import 'dart:ui' show Offset, Rect;

import '../../gen/vibevalley.dart';
import '../../rules/farm.dart';
import '../../shared/looks.dart' show Pose;

sealed class Spot {
  const Spot();
}

final class SpotTaken extends Spot {
  const SpotTaken(this.session, this.plot);
  final Session session;
  final PlotView plot;
}

final class SpotOpen extends Spot {
  const SpotOpen();
}

final class SpotShut extends Spot {
  const SpotShut();
}

class Island {
  const Island({required this.project, required this.summary, required this.spots, required this.working, required this.slots, required this.queued});
  final String project;

  /// Null for a project the list does not have (any more) that helpers are still in.
  final ProjectSummary? summary;

  final List<Spot> spots;

  final int working;
  final int slots;

  final List<Issue> queued;

  Iterable<Session> get sessions => spots.whereType<SpotTaken>().map((s) => s.session);
  int get open => spots.whereType<SpotOpen>().length;
  bool get full => working >= slots;
}

List<Island> islandsOf({
  required List<ProjectSummary> projects,
  required List<Session> sessions,
  required Map<String, PlotView> plots,
  required List<Issue> issues,
}) {
  final free = math.max(0, maxRunning - sessions.where(isBusy).length);
  final byName = {for (final p in projects) p.name: p};
  final names = {...byName.keys, for (final h in sessions) ?h.project};
  final islands = [
    for (final name in names)
      _island(
        name,
        byName[name],
        [...sessions.where((h) => h.project == name)]..sort((a, b) => a.hiredAt.compareTo(b.hiredAt)),
        plots,
        [...issues.where((i) => i.project == name && i.status == IssueStatus.todo)]..sort((a, b) => a.queuedAt!.compareTo(b.queuedAt!)),
        free,
      ),
  ];
  int quiet(Island i) => i.spots.any((s) => s is SpotTaken) || i.queued.isNotEmpty ? 0 : 1;
  return islands..sort((a, b) {
    final byQuiet = quiet(a).compareTo(quiet(b));
    if (byQuiet != 0) return byQuiet;
    final byLast = (b.summary?.last ?? 0).compareTo(a.summary?.last ?? 0);
    return byLast != 0 ? byLast : a.project.compareTo(b.project);
  });
}

Island _island(String name, ProjectSummary? summary, List<Session> mine, Map<String, PlotView> plots, List<Issue> queued, int free) {
  final working = mine.where(isBusy).length;
  // A project the list does not have takes no more work: only its helpers show.
  final slots = summary == null ? working : summary.slots.round();
  final room = math.max(0, math.min(slots - working, maxRunning - mine.length));
  final open = math.min(room, free);
  return Island(
    project: name,
    summary: summary,
    spots: [
      for (final h in mine) SpotTaken(h, plots[h.id] ?? const PlotView(crop: Crop.seeded)),
      for (var i = 0; i < open; i++) const SpotOpen(),
      for (var i = open; i < room; i++) const SpotShut(),
    ],
    working: working,
    slots: slots,
    queued: queued,
  );
}

List<Session> homeless(List<Session> sessions) => [
  for (final h in sessions)
    if (h.project == null) h,
];

({int peopled, int working, int queued}) mapTally(List<Island> islands) => (
  peopled: islands.where((i) => i.spots.any((s) => s is SpotTaken)).length,
  working: islands.fold(0, (n, i) => n + i.working),
  queued: islands.fold(0, (n, i) => n + i.queued.length),
);

/// village/world.dart plotW, plotH.
const _plotW = 34.0;
const _plotH = 26.0;

const _head = 15.0;

const _rowPitch = 36.0;
const _maxColPitch = 54.0;

/// Rows of three at most from the back, as even as they go (four is two and two), each row and the whole block centred.
List<Offset> plotsIn(Rect yard, int n) {
  if (n <= 0) return const [];
  final rows = (n / 3).ceil();
  final perRow = (n / rows).ceil();
  final pitch = perRow == 1 ? 0.0 : math.min(_maxColPitch, (yard.width - _plotW - 8) / (perRow - 1));
  final block = _head + _plotH + (rows - 1) * _rowPitch;
  final firstBottom = yard.center.dy - block / 2 + _head + _plotH;
  return [
    for (var i = 0; i < n; i++)
      Offset(yard.center.dx + (i % perRow - (math.min(perRow, n - i ~/ perRow * perRow) - 1) / 2) * pitch, firstBottom + (i ~/ perRow) * _rowPitch),
  ];
}

const sessionInPlot = Offset(0, -10);

Pose mapPose(Session h) {
  if ((canHarvest(h) && h.conflict != null) || h.phase is PhaseFailed) return Pose.worry;
  return switch (h.phase) {
    PhaseWorking(doing: Doing(action: SessionAction.thinking || SessionAction.speakingText)) => Pose.think,
    PhaseWorking() => Pose.work,
    PhaseRipe() => Pose.cheer,
    PhaseFailed() => Pose.worry,
    PhaseArriving() || PhaseResting() => Pose.idle,
  };
}

String spotText(Spot spot, double now) => switch (spot) {
  SpotTaken(:final session) => '${session.name} · ${phaseText(session, now)}${session.branch != null ? '\n分支 ${session.branch}' : ''}',
  SpotOpen() => '空位：派一件活来，马上开工',
  SpotShut() => '农场的 $maxRunning 块地都有人在干活，等有人干完',
};

String islandText(Island i) =>
    [if (i.summary == null) '不在工作目录里了' else '在干 ${i.working}/${i.slots}${i.full ? '（满了）' : ''}', if (i.queued.isNotEmpty) '排队 ${i.queued.length}'].join(' · ');

double islandScale(double width, double cell, double gap) {
  for (final s in const [2.0, 1.5]) {
    if (2 * cell * s + gap <= width) return s;
  }
  final one = width / cell;
  return one >= 1.5 ? math.min(2.5, (one * 2).floor() / 2) : one;
}

const islandLooks = ['island-meadow', 'island-orchard', 'island-pond', 'island-pines', 'island-windmill', 'island-lavender'];

/// The same one every time, from its name.
String islandLook(String project) {
  var h = 0;
  for (final r in project.runes) {
    h = (h * 31 + r) & 0x7FFFFFFF;
  }
  return islandLooks[h % islandLooks.length];
}
