// 小恐龙: the farm phone's runner (packages/core/src/dino.ts). A little dinosaur runs along the ground; jump the
// cacti, duck or jump the birds; it runs faster the further it goes. Pure, like blocks.dart: a run is a value and
// `run` moves it on by some milliseconds; the phone runs the clock and draws it (dino_game.dart). Sizes are the game's
// own pixels on a 104×40 strip, y down; obstacles come from the run's own seeded generator, so a seed replays.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'random.dart';

const dinoWidth = 104;
const dinoHeight = 40;

/// The ground line: where feet stand.
const dinoGround = 35;
const _dinoX = 8;

const dinoRunSize = (w: 12, h: 14);
const dinoDuckSize = (w: 16, h: 8);

enum ObstacleKind { cactus, cacti, bird }

class Obstacle {
  const Obstacle({required this.kind, required this.x, required this.y, required this.w, required this.h});
  final ObstacleKind kind;

  /// Its left edge, moving left.
  final double x;

  /// Its top.
  final double y;
  final double w;
  final double h;

  Obstacle at(double x) => Obstacle(kind: kind, x: x, y: y, w: w, h: h);

  @override
  bool operator ==(Object other) => other is Obstacle && other.kind == kind && other.x == x && other.y == y && other.w == w && other.h == h;

  @override
  int get hashCode => Object.hash(kind, x, y, w, h);
}

class Dino {
  const Dino({
    required this.lift,
    required this.rise,
    required this.ducking,
    required this.obstacles,
    required this.speed,
    required this.distance,
    required this.gap,
    required this.seed,
    required this.over,
    required this.time,
  });

  /// The dinosaur's height above the ground (0 on it), and its speed upward, in pixels per millisecond.
  final double lift;
  final double rise;
  final bool ducking;
  final List<Obstacle> obstacles;

  /// How fast the ground moves, in pixels per millisecond.
  final double speed;

  /// Pixels run: the score is a tenth of it.
  final double distance;

  /// Ground to cover before the next obstacle.
  final double gap;
  final int seed;
  final bool over;

  /// Milliseconds run, for the legs' and wings' frames.
  final double time;

  Dino copyWith({
    double? lift,
    double? rise,
    bool? ducking,
    List<Obstacle>? obstacles,
    double? speed,
    double? distance,
    double? gap,
    int? seed,
    bool? over,
    double? time,
  }) => Dino(
    lift: lift ?? this.lift,
    rise: rise ?? this.rise,
    ducking: ducking ?? this.ducking,
    obstacles: obstacles ?? this.obstacles,
    speed: speed ?? this.speed,
    distance: distance ?? this.distance,
    gap: gap ?? this.gap,
    seed: seed ?? this.seed,
    over: over ?? this.over,
    time: time ?? this.time,
  );

  @override
  bool operator ==(Object other) =>
      other is Dino &&
      other.lift == lift &&
      other.rise == rise &&
      other.ducking == ducking &&
      listEquals(other.obstacles, obstacles) &&
      other.speed == speed &&
      other.distance == distance &&
      other.gap == gap &&
      other.seed == seed &&
      other.over == over &&
      other.time == time;

  @override
  int get hashCode => Object.hash(lift, rise, ducking, Object.hashAll(obstacles), speed, distance, gap, seed, over, time);
}

// A floaty jump, about 27 pixels up and half a second in the air: long enough to clear the widest cacti at the
// starting speed with room to spare (phone_games_test.dart checks it).
const _gravity = 0.0008;
const _jump = 0.21;

/// Holding down while in the air pulls it down faster.
const _dive = 0.004;
const _startSpeed = 0.08;
const _topSpeed = 0.17;

/// Speed gained per pixel run.
const _speedUp = 0.000008;

/// Birds only once it has run this far.
const _birdsFrom = 2000;

Dino newDino(int seed) =>
    Dino(lift: 0, rise: 0, ducking: false, obstacles: const [], speed: _startSpeed, distance: 0, gap: 40, seed: seed, over: false, time: 0);

int dinoScore(Dino d) => (d.distance / 10).floor();

/// Jumps, from the ground only.
Dino jump(Dino d) => d.over || d.lift > 0 ? d : d.copyWith(rise: _jump, ducking: false);

/// Ducks on the ground; in the air it dives.
Dino duck(Dino d, bool down) => d.over ? d : d.copyWith(ducking: down);

typedef Box = ({double x, double y, double w, double h});

/// The dinosaur's box now: lower and longer while it ducks on the ground.
Box dinoBox(Dino d) {
  final size = d.ducking && d.lift == 0 ? dinoDuckSize : dinoRunSize;
  return (x: _dinoX.toDouble(), y: dinoGround - d.lift - size.h, w: size.w.toDouble(), h: size.h.toDouble());
}

(Obstacle, double, int) _spawn(Dino d, int seed) {
  final (r1, s1) = nextRandom(seed);
  final (r2, s2) = nextRandom(s1);
  final birds = d.distance > _birdsFrom;
  final kind = birds && r1 < 0.25 ? ObstacleKind.bird : (r1 < 0.65 ? ObstacleKind.cactus : ObstacleKind.cacti);
  final (w, h, y) = switch (kind) {
    // Low birds are jumped, high ones ducked under.
    ObstacleKind.bird => (12, 8, r2 < 0.5 ? dinoGround - 12 : dinoGround - 18),
    ObstacleKind.cactus => (6, 12, dinoGround - 12),
    ObstacleKind.cacti => (12, 10, dinoGround - 10),
  };
  // Faster runs leave more room, so a jump can always clear one obstacle before the next.
  final gap = 50 + r2 * 60 + d.speed * 200;
  return (Obstacle(kind: kind, x: dinoWidth.toDouble(), y: y.toDouble(), w: w.toDouble(), h: h.toDouble()), gap, s2);
}

/// Two boxes overlap, with grace (two pixels at the sides, where the pictures' corners are empty; one above and
/// below): a graze is not a hit.
bool _hits(Box a, Obstacle b) => a.x + 2 < b.x + b.w - 2 && b.x + 2 < a.x + a.w - 2 && a.y + 1 < b.y + b.h - 1 && b.y + 1 < a.y + a.h - 1;

/// The run `ms` milliseconds on: it falls or rises, the ground moves, obstacles come and go, a hit ends it.
Dino run(Dino d, double ms) {
  if (d.over) return d;
  final dt = math.min(ms, 50.0);
  final pull = _gravity + (d.ducking && d.lift > 0 ? _dive : 0);
  var rise = d.rise - pull * dt;
  var lift = d.lift + rise * dt;
  if (lift <= 0) (lift, rise) = (0.0, 0.0);
  final moved = d.speed * dt;
  var obstacles = [
    for (final o in d.obstacles)
      if (o.x - moved + o.w > 0) o.at(o.x - moved),
  ];
  var gap = d.gap - moved;
  var seed = d.seed;
  if (gap <= 0) {
    final (o, next, s) = _spawn(d, seed);
    obstacles = [...obstacles, o];
    gap = next;
    seed = s;
  }
  final next = d.copyWith(
    lift: lift,
    rise: rise,
    obstacles: obstacles,
    gap: gap,
    seed: seed,
    distance: d.distance + moved,
    speed: math.min(_topSpeed, d.speed + moved * _speedUp),
    time: d.time + dt,
  );
  final me = dinoBox(next);
  return obstacles.any((o) => _hits(me, o)) ? next.copyWith(over: true) : next;
}
