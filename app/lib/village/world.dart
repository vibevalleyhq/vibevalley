// Where things stand in the pixel village, in art pixels (web/src/pixel/world.ts and places.ts): the positions come
// from the LDtk level; this file names them and works out what follows: the beds, the spots around a plot, the
// queue, the walk map, and where a helper stands for what it is doing.

import '../gen/vibevalley.dart';
import 'level.dart';
import 'nav.dart';

/// A bed in the grid, back to front: working beds for each station, then the locked ones (core farm.ts BEDS).
class Bed {
  const Bed(this.index, this.station, [this.unlockLevel]);
  final int index;

  /// Station index for working beds; -1 for locked ones.
  final int station;

  /// Locked beds: the farm level that clears them.
  final int? unlockLevel;
}

/// The farm's MAX_RUNNING working beds, then three locked ones cleared at levels 5, 8 and 12.
const beds = [Bed(0, 0), Bed(1, 1), Bed(2, 2), Bed(3, 3), Bed(4, 4), Bed(5, 5), Bed(6, -1, 5), Bed(7, -1, 8), Bed(8, -1, 12)];

Bed? bedOfStation(int station) => station < 0 ? null : beds.where((b) => b.station == station).firstOrNull;

/// A plot's footprint around its bottom-centre point.
const plotW = 34.0;
const plotH = 26.0;

/// Around a plot, from its bottom-centre: where a helper stands to look on.
const around = {'front': Pt(0, 5), 'left': Pt(-24, -10), 'right': Pt(24, -10), 'back': Pt(6, -29)};

/// In a plot's soil, from its bottom-centre: where a helper stands to work it (the tool lands in the soil).
const inBed = {'front': Pt(0, -9), 'left': Pt(-7, -11), 'right': Pt(7, -11), 'back': Pt(0, -13)};

/// At its plot a helper faces the plot.
const _facingAt = {'front': 'up', 'back': 'down', 'left': 'right', 'right': 'left'};

/// A prop in the yard: what a click on it opens, and its picture.
class Prop {
  const Prop(this.spot, this.sprite, this.at, this.box);
  final String spot;
  final String sprite;
  final Pt at;
  final Box box;
}

/// What a click in the yard opens: the farm's panels and pages, as things standing in the village (world.ts SPOTS).
const spotNames = {
  'shop': ('商店', '种子、装饰、开垦新地'),
  'warehouse': ('仓库', '收进来的成果'),
  'tasks': ('任务与成就', '新手任务、开垦、成就墙'),
  'log': ('农场日志', '说过的话和收成，按时间倒着排'),
  'plans': ('种植计划', '一件长活拆成几步，交给几个帮工'),
  'agents': ('帮工名册', '每个帮工用哪台农机、带什么人设和技能、长什么样'),
  'manager': ('管家', '换管家的样子'),
  'runtimes': ('工坊 · 农具', '每台农机是一种 runtime：装没装、用量'),
  'skills': ('书屋 · 技能书', '帮工能带的技能'),
};

/// Where a helper is headed, and which way it faces once there.
class Goal {
  const Goal(this.key, this.at, [this.facing]);
  final String key;
  final Pt at;
  final String? facing;
}

class VillageWorld {
  VillageWorld(this.level)
    : plots = {for (final t in level.thingsOf('Plot')) (t.field('index') as num).toInt(): t.at},
      gate = level.theThing('Gate').at,
      queue = level.theThing('Queue').at,
      manager = level.theThing('Manager').at,
      dog = level.theThing('Dog').at,
      lawn = ([...level.thingsOf('Rest')]..sort((a, b) => (a.field('n') as num).compareTo(b.field('n') as num))).map((t) => t.at).toList(),
      lights = [for (final t in level.thingsOf('Light')) (at: t.at, r: (t.field('r') as num).toDouble())],
      props = [for (final t in level.thingsOf('Prop')) Prop(t.field('spot') as String, t.field('sprite') as String, t.at, t.box)];

  final Level level;
  final Map<int, Pt> plots;
  final Pt gate;
  final Pt queue;
  final Pt manager;
  final Pt dog;
  final List<Pt> lawn;
  final List<({Pt at, double r})> lights;
  final List<Prop> props;

  double get width => level.width;
  double get height => level.height;

  /// Where the yard comes alive, by kind (chimney, anvil, mast, pond): the level's Fx boxes (world.ts FX).
  late final Map<String, List<Box>> fx = {
    for (final kind in const ['chimney', 'anvil', 'mast', 'pond'])
      kind: [
        for (final t in level.thingsOf('Fx'))
          if (t.field('kind') == kind) t.box,
      ],
  };

  /// Each spot's box: its prop's picture, or the level's Area for things that are part of the map.
  late final Map<String, Box> spotBoxes = {
    for (final spot in spotNames.keys)
      spot: (level.thingsOf('Prop').where((t) => t.field('spot') == spot).firstOrNull ?? level.thingsOf('Area').firstWhere((t) => t.field('spot') == spot)).box,
  };

  Pt plotAt(int index) => plots[index] ?? (throw StateError('village.ldtk: no Plot $index'));

  Box plotBox(int index) {
    final p = plotAt(index);
    return (x0: p.x - plotW / 2, y0: p.y - plotH + 2, x1: p.x + plotW / 2, y1: p.y);
  }

  /// Where helpers wait when every plot is taken: a line back from the gate.
  Pt queueSpot(int n) => Pt(queue.x - n * 13, queue.y + (n % 2) * 4);

  /// The level's ground, less the plots and the props' feet (they are the game's, so they can move).
  bool walkable(Pt p) =>
      level.ground1(p) &&
      !props.any((s) => inBox(p, (x0: s.box.x0, y0: s.box.y1 - 7, x1: s.box.x1, y1: s.box.y1 + 1))) &&
      !List.generate(9, plotBox).any((b) => inBox(p, b));

  late final nav = NavMap(w: width + 16, h: height, cell: 2, clearance: 2, walkable: walkable);

  /// The buildings helpers walk to for what they are doing, and which way they face there (world.ts PLACES).
  late final Map<String, ({Pt at, String facing})> places = {
    for (final t in level.thingsOf('Place'))
      t.field('place') as String: (
        at: t.at,
        facing: switch (t.field('facing')) {
          'down' => 'down',
          'left' => 'left',
          'right' => 'right',
          _ => 'up',
        },
      ),
  };

  /// Where a helper stands now (places.ts goalOf): at the gate when it left, in the queue when every plot is taken;
  /// in front of its plot when the plot calls for you; at the building its work takes it to (`place`), side by side
  /// with whoever else is there (`crowd` of them before it); on the lawn when it strolls there; in the soil while it
  /// works it; around its plot otherwise.
  Goal goalOf({
    required bool here,
    required int station,
    required int queueIndex,
    required bool calls,
    required String place,
    required Stroll? stroll,
    required String pose,
    required int Function(String key) crowd,
  }) {
    if (!here) return Goal('gate', gate);
    final bed = bedOfStation(station);
    if (bed == null) return Goal('queue:$queueIndex', queueSpot(queueIndex));
    final plot = plotAt(bed.index);
    // A ripe or failing plot keeps its helper in front, facing us, to cheer or worry.
    if (calls) return Goal('plot:front', plot + Pt(0, around['front']!.y), 'down');
    if (place != 'plot' && places.containsKey(place)) {
      final n = crowd(place);
      final (:at, :facing) = places[place]!;
      if (facing == 'left' || facing == 'right') return _besideIt(place, at, facing, n);
      // Several at one building: side by side in front of it.
      return Goal(place, Pt(at.x + (n.isOdd ? 1 : -1) * (n / 2).ceil() * 12, at.y + n % 3), facing);
    }
    final spot = stroll?.spot ?? 'right';
    final rest = stroll?.rest ?? 0;
    if (spot == 'rest') return Goal('rest:$rest', lawn[rest % lawn.length]);
    // Working the soil, it stands in the bed, facing us; otherwise around it, facing it.
    if (pose == 'work') return Goal('bed:$spot', plot + inBed[spot]!, 'down');
    return Goal('plot:$spot', plot + around[spot]!, _facingAt[spot]);
  }

  /// What a helper works from the side (the anvil) is this far in front of where it stands.
  static const _reach = 15.0;

  /// The `n`th helper at what is worked from the side: the first at its spot, the second across it, the rest in front.
  Goal _besideIt(String key, Pt at, String facing, int n) {
    final dir = facing == 'right' ? 1 : -1;
    if (n == 0) return Goal(key, at, facing);
    if (n == 1) return Goal(key, Pt(at.x + dir * _reach * 2, at.y), facing == 'right' ? 'left' : 'right');
    return Goal(key, Pt(at.x + dir * _reach + (n.isOdd ? -12 : 12) * ((n - 1) / 2).ceil(), at.y + 12), 'up');
  }
}

bool isRipe(Crop crop) => crop == Crop.wheat || crop == Crop.carrot;

/// Actions that need both hands. Reading, searching and thinking are done standing, chin in paw.
const _handsOn = {WorkerAction.editFile, WorkerAction.runCommand, WorkerAction.mcp, WorkerAction.other};

/// How a helper stands at its bed (core farm.ts poseOf): cheering when ripe, worried when stuck, hands on for edits.
String poseOf(Helper h, Crop crop) {
  if (isRipe(crop)) return 'cheer';
  if (crop == Crop.withered || crop == Crop.dry) return 'worry';
  final phase = h.phase;
  if (phase is! PhaseWorking || phase.doing.action == WorkerAction.none) return 'idle';
  return _handsOn.contains(phase.doing.action) ? 'work' : 'think';
}

const _species = ['bear', 'rabbit', 'fox', 'cat', 'owl', 'hedgehog', 'raccoon'];

int _hash(String s) {
  var h = 0;
  for (final c in s.runes) {
    h = (h * 31 + c) & 0xFFFFFFFF;
  }
  return h;
}

/// The sprite name prefix for a helper: its agent's animal and clothes (core farm.ts castOf); agents saved before the
/// farm get an animal picked from their id, the same one every time.
String lookOf(AgentProfile? agent, String agentId, bool Function(String) has) {
  final species = agent?.look.species?.wire ?? _species[_hash(agentId) % _species.length];
  final outfit = agent?.look.outfit?.wire ?? 'farmer';
  return ['$species-$outfit', '$species-farmer', 'bear-farmer'].firstWhere((l) => has('$l-down'), orElse: () => 'bear-farmer');
}

/// The place an action takes a helper to (core village.ts placeOfAction). Hands-on work and thinking happen at its plot.
String placeOfAction(WorkerAction action) => switch (action) {
  WorkerAction.readFile || WorkerAction.search => 'library',
  WorkerAction.runCommand || WorkerAction.mcp => 'workshop',
  WorkerAction.web => 'mast',
  WorkerAction.wait => 'bench',
  _ => 'plot',
};

/// A ripe or failing plot calls its helper back at once, to cheer or to worry (core village.ts plotCalls).
bool plotCalls(Crop crop) => isRipe(crop) || crop == Crop.withered || crop == Crop.dry;

/// Where a helper may stand around its plot, given what it is doing (core farm.ts spotsFor).
List<String> spotsFor(Helper h, Crop crop, String pose) {
  if (isRipe(crop) || crop == Crop.dry) return const ['front'];
  if (crop == Crop.withered) return const ['front', 'left', 'right'];
  return switch (h.phase) {
    PhaseArriving() => const ['right'],
    PhaseWorking() => pose == 'work' ? const ['front', 'right', 'left'] : const ['left', 'back', 'right'],
    PhaseResting() => const ['rest', 'rest', 'front', 'back'],
    _ => const ['front'],
  };
}

/// Where a helper is among the buildings (core village.ts Whereabouts): where it went and since when, where it would
/// rather be and since when. It sets off once it has wanted the new place for SETTLE and been where it is for DWELL;
/// a newcomer walks in to its plot first.
class Whereabouts {
  Whereabouts(this.place, this.since, this.want, this.wantSince);
  String place;
  double since;
  String want;
  double wantSince;

  static const settle = 1.2;
  static const dwell = 2.0;

  void moveOn(String to, double now, {bool urgent = false}) {
    if (to != want) {
      want = to;
      wantSince = now;
    }
    if (want == place) return;
    if (urgent || (now - wantSince >= settle && now - since >= dwell)) {
      place = want;
      since = now;
    }
  }
}

/// How many lawn places helpers wander to when resting (core farm.ts REST_SPOTS).
const restSpots = 5;

/// How long a helper stays put, seconds: a few while working, longer when it has nothing to do (core farm.ts DWELL).
const strollDwell = {'working': (5.0, 11.0), 'other': (7.0, 15.0)};

/// Where a helper strolls around its plot, and until when (core farm.ts Stroll, runStrolls).
class Stroll {
  Stroll(this.spot, this.rest, this.until);
  final String spot;
  final int rest;
  final double until;
}
