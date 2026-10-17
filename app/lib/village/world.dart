// The positions come from the LDtk level; this file names them and works out what follows.

import '../gen/vibevalley.dart';
import 'level.dart';
import 'nav.dart';

class Bed {
  const Bed(this.index, this.station, [this.unlockLevel]);
  final int index;

  /// -1 for locked ones.
  final int station;

  final int? unlockLevel;
}

const beds = [Bed(0, 0), Bed(1, 1), Bed(2, 2), Bed(3, 3), Bed(4, 4), Bed(5, 5), Bed(6, -1, 5), Bed(7, -1, 8), Bed(8, -1, 12)];

Bed? bedOfStation(int station) => station < 0 ? null : beds.where((b) => b.station == station).firstOrNull;

const plotW = 34.0;
const plotH = 26.0;

const around = {'front': Pt(0, 5), 'left': Pt(-24, -10), 'right': Pt(24, -10), 'back': Pt(6, -29)};

const inBed = {'front': Pt(0, -9), 'left': Pt(-7, -11), 'right': Pt(7, -11), 'back': Pt(0, -13)};

const _facingAt = {'front': 'up', 'back': 'down', 'left': 'right', 'right': 'left'};

class Prop {
  const Prop(this.spot, this.sprite, this.at, this.box);
  final String spot;
  final String sprite;
  final Pt at;
  final Box box;
}

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

  late final Map<String, List<Box>> fx = {
    for (final kind in const ['chimney', 'anvil', 'mast', 'pond'])
      kind: [
        for (final t in level.thingsOf('Fx'))
          if (t.field('kind') == kind) t.box,
      ],
  };

  late final Map<String, Box> spotBoxes = {
    for (final spot in spotNames.keys)
      spot: (level.thingsOf('Prop').where((t) => t.field('spot') == spot).firstOrNull ?? level.thingsOf('Area').firstWhere((t) => t.field('spot') == spot)).box,
  };

  Pt plotAt(int index) => plots[index] ?? (throw StateError('village.ldtk: no Plot $index'));

  Box plotBox(int index) {
    final p = plotAt(index);
    return (x0: p.x - plotW / 2, y0: p.y - plotH + 2, x1: p.x + plotW / 2, y1: p.y);
  }

  Pt queueSpot(int n) => Pt(queue.x - n * 13, queue.y + (n % 2) * 4);

  /// The plots and the props' feet are left out of the level's ground: they are the game's, so they can move.
  bool walkable(Pt p) =>
      level.ground1(p) &&
      !props.any((s) => inBox(p, (x0: s.box.x0, y0: s.box.y1 - 7, x1: s.box.x1, y1: s.box.y1 + 1))) &&
      !List.generate(9, plotBox).any((b) => inBox(p, b));

  late final nav = NavMap(w: width + 16, h: height, cell: 2, clearance: 2, walkable: walkable);

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
    if (calls) return Goal('plot:front', plot + Pt(0, around['front']!.y), 'down');
    if (place != 'plot' && places.containsKey(place)) {
      final n = crowd(place);
      final (:at, :facing) = places[place]!;
      if (facing == 'left' || facing == 'right') return _besideIt(place, at, facing, n);
      return Goal(place, Pt(at.x + (n.isOdd ? 1 : -1) * (n / 2).ceil() * 12, at.y + n % 3), facing);
    }
    final spot = stroll?.spot ?? 'right';
    final rest = stroll?.rest ?? 0;
    if (spot == 'rest') return Goal('rest:$rest', lawn[rest % lawn.length]);
    if (pose == 'work') return Goal('bed:$spot', plot + inBed[spot]!, 'down');
    return Goal('plot:$spot', plot + around[spot]!, _facingAt[spot]);
  }

  /// What a helper works from the side (the anvil) is this far in front of where it stands.
  static const _reach = 15.0;

  Goal _besideIt(String key, Pt at, String facing, int n) {
    final dir = facing == 'right' ? 1 : -1;
    if (n == 0) return Goal(key, at, facing);
    if (n == 1) return Goal(key, Pt(at.x + dir * _reach * 2, at.y), facing == 'right' ? 'left' : 'right');
    return Goal(key, Pt(at.x + dir * _reach + (n.isOdd ? -12 : 12) * ((n - 1) / 2).ceil(), at.y + 12), 'up');
  }
}

bool isRipe(Crop crop) => crop == Crop.wheat || crop == Crop.carrot;

const _handsOn = {SessionAction.editFile, SessionAction.runCommand, SessionAction.mcp, SessionAction.other};

String poseOf(Session h, Crop crop) {
  if (isRipe(crop)) return 'cheer';
  if (crop == Crop.withered || crop == Crop.dry) return 'worry';
  final phase = h.phase;
  if (phase is! PhaseWorking || phase.doing.action == SessionAction.none) return 'idle';
  return _handsOn.contains(phase.doing.action) ? 'work' : 'think';
}

String placeOfAction(SessionAction action) => switch (action) {
  SessionAction.readFile || SessionAction.search => 'library',
  SessionAction.runCommand || SessionAction.mcp => 'workshop',
  SessionAction.web => 'mast',
  SessionAction.wait => 'bench',
  _ => 'plot',
};

bool plotCalls(Crop crop) => isRipe(crop) || crop == Crop.withered || crop == Crop.dry;

List<String> spotsFor(Session h, Crop crop, String pose) {
  if (isRipe(crop) || crop == Crop.dry) return const ['front'];
  if (crop == Crop.withered) return const ['front', 'left', 'right'];
  return switch (h.phase) {
    PhaseArriving() => const ['right'],
    PhaseWorking() => pose == 'work' ? const ['front', 'right', 'left'] : const ['left', 'back', 'right'],
    PhaseResting() => const ['rest', 'rest', 'front', 'back'],
    _ => const ['front'],
  };
}

/// It sets off once it has wanted the new place for SETTLE and been where it is for DWELL.
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

const restSpots = 5;

const strollDwell = {'working': (5.0, 11.0), 'other': (7.0, 15.0)};

class Stroll {
  Stroll(this.spot, this.rest, this.until);
  final String spot;
  final int rest;
  final double until;
}
