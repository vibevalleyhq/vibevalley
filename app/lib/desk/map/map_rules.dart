// The map's rules (地图, map_page.dart): every project is an island, and the plots in its yard are its worktrees (a
// helper working or waiting in one) and the room for more. The room is the project's slots (ProjectSummary.slots, how
// many helpers may work in it at once) less its working helpers, as far as the farm's beds go: what the server's
// crewNoRoom allows. Read off the farm's state, its view, the project list and the issues; nothing here folds facts.

import 'dart:math' as math;
import 'dart:ui' show Offset, Rect;

import '../../gen/vibevalley.dart';
import '../../rules/farm.dart';
import '../../rules/tickets.dart' show workingBeds;
import '../shared/looks.dart' show Pose;

/// A plot in an island's yard.
sealed class Spot {
  const Spot();
}

/// A helper's worktree: the helper and what grows in its plot.
final class SpotTaken extends Spot {
  const SpotTaken(this.helper, this.plot);
  final Helper helper;
  final PlotView plot;
}

/// Room for one more: a job sent to this project starts at once.
final class SpotOpen extends Spot {
  const SpotOpen();
}

/// One of the project's slots that the farm cannot give now: every bed has someone working in it.
final class SpotShut extends Spot {
  const SpotShut();
}

/// A project as an island on the map.
class Island {
  const Island({required this.project, required this.summary, required this.spots, required this.working, required this.slots, required this.queued});
  final String project;

  /// From the project list; null for one the list does not have (any more), that helpers are still in.
  final ProjectSummary? summary;

  /// Its worktrees in the order the helpers came, then the room for more.
  final List<Spot> spots;

  /// How many of its helpers are working, and how many may at once.
  final int working;
  final int slots;

  /// Issues for it waiting for room (queued), the first in line first.
  final List<Issue> queued;

  Iterable<Helper> get helpers => spots.whereType<SpotTaken>().map((s) => s.helper);
  int get open => spots.whereType<SpotOpen>().length;
  bool get full => working >= slots;
}

/// The most plots a yard holds: two rows of three.
const yardPlots = 6;

/// Every project's island, the ones being worked or waited on first, then the newest-worked; and any project a
/// helper is in that the list does not have.
List<Island> islandsOf({
  required List<ProjectSummary> projects,
  required List<Helper> helpers,
  required Map<String, PlotView> plots,
  required List<Issue> issues,
}) {
  final free = math.max(0, workingBeds - helpers.where(isBusy).length);
  final byName = {for (final p in projects) p.name: p};
  final names = {...byName.keys, for (final h in helpers) ?h.project};
  final islands = [
    for (final name in names)
      _island(
        name,
        byName[name],
        [...helpers.where((h) => h.project == name)]..sort((a, b) => a.hiredAt.compareTo(b.hiredAt)),
        plots,
        [...issues.where((i) => i.project == name && i.status == IssueStatus.queued)]..sort((a, b) => a.queuedAt!.compareTo(b.queuedAt!)),
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

Island _island(String name, ProjectSummary? summary, List<Helper> mine, Map<String, PlotView> plots, List<Issue> queued, int free) {
  final working = mine.where(isBusy).length;
  // A project the list does not have takes no more work: only its helpers show.
  final slots = summary == null ? working : summary.slots.round();
  final room = math.max(0, math.min(slots - working, yardPlots - mine.length));
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

/// Helpers in no project (working in the work directory itself): on no island.
List<Helper> homeless(List<Helper> helpers) => [
  for (final h in helpers)
    if (h.project == null) h,
];

/// The farm at a glance: islands with someone on them, beds working, jobs in line.
({int peopled, int working, int queued}) mapTally(List<Island> islands) => (
  peopled: islands.where((i) => i.spots.any((s) => s is SpotTaken)).length,
  working: islands.fold(0, (n, i) => n + i.working),
  queued: islands.fold(0, (n, i) => n + i.queued.length),
);

// ── Where things stand in a yard ─────────────────────────────────────────────

/// A plot's frame, art pixels (village/world.dart plotW, plotH).
const _plotW = 34.0;
const _plotH = 26.0;

/// How far a helper standing in its plot reaches above the plot's top.
const _head = 15.0;

/// From one row of plots to the next, and the widest from one plot to the next along a row.
const _rowPitch = 36.0;
const _maxColPitch = 54.0;

/// Where `n` plots stand in a yard (each one's bottom middle), in rows of three at most from the back, the rows as even
/// as they go (four is two and two), each row and the whole block centred.
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

/// Where a helper stands in its plot, from the plot's bottom middle: in the soil, facing out.
const helperInPlot = Offset(0, -10);

/// How a helper looks on its plot: at work, thinking it over, cheering a ripe crop, worried over a failure or a
/// conflict, standing by otherwise.
Pose mapPose(Helper h) {
  final need = needOf(h);
  if (need is NeedConflict || need is NeedFix) return Pose.worry;
  return switch (h.phase) {
    PhaseWorking(doing: Doing(action: WorkerAction.thinking || WorkerAction.speakingText)) => Pose.think,
    PhaseWorking() => Pose.work,
    PhaseRipe() => Pose.cheer,
    PhaseFailed() => Pose.worry,
    PhaseArriving() || PhaseResting() => Pose.idle,
  };
}

/// What a plot is, in a few words (its tooltip).
String spotText(Spot spot, double now) => switch (spot) {
  SpotTaken(:final helper) => '${helper.name} · ${phaseText(helper, now)}${helper.branch != null ? '\n分支 ${helper.branch}' : ''}',
  SpotOpen() => '空位：派一件活来，马上开工',
  SpotShut() => '农场的 $workingBeds 块地都有人在干活，等有人干完',
};

/// How an island is doing, in a few words: 「在干 2/3 · 排队 1」.
String islandText(Island i) =>
    [if (i.summary == null) '不在工作目录里了' else '在干 ${i.working}/${i.slots}${i.full ? '（满了）' : ''}', if (i.queued.isNotEmpty) '排队 ${i.queued.length}'].join(' · ');

/// How big the islands are drawn, screen pixels to an art pixel, in a row `width` wide of cells `cell` art pixels wide
/// `gap` apart: twice, or one and a half times, when two fit side by side; else one to the row as big as fits, up to
/// two and a half times, in half steps; on a phone, whatever fits its width.
double islandScale(double width, double cell, double gap) {
  for (final s in const [2.0, 1.5]) {
    if (2 * cell * s + gap <= width) return s;
  }
  final one = width / cell;
  return one >= 1.5 ? math.min(2.5, (one * 2).floor() / 2) : one;
}

// ── Which island picture ─────────────────────────────────────────────────────

/// The island pictures (design/pixel `gen.sh island-<rim>`).
const islandLooks = ['island-meadow', 'island-orchard', 'island-pond', 'island-pines', 'island-windmill', 'island-lavender'];

/// A project's island: the same one every time, from its name.
String islandLook(String project) {
  var h = 0;
  for (final r in project.runes) {
    h = (h * 31 + r) & 0x7FFFFFFF;
  }
  return islandLooks[h % islandLooks.length];
}
