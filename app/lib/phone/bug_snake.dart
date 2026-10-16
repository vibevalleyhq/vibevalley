// 贪吃虫: the farm phone's snake (packages/core/src/bugsnake.ts). A caterpillar crawls a 16×14 field a cell a tick; it
// eats the seeds lying there to grow a segment, and now and then a farm bug lands: eaten before it flies off it is
// worth more the sooner, and two segments. The wall or its own body ends the run. Pure, like blocks.dart: a run is a
// value, `crawlBugSnake` moves it a tick and `steerBugSnake` queues a turn; the phone runs the clock and draws it
// (bug_snake_game.dart). Cells are y * width + x; seeds and bugs land on free cells drawn with the run's own seeded
// generator, so a seed replays the web page's run.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'random.dart';

const bugSnakeWidth = 16;
const bugSnakeHeight = 14;

enum SnakeHeading { up, down, left, right }

/// How a run ended: into the wall, into itself, or no room left for a seed.
enum BugSnakeEnd { wall, self, full }

class BugSnake {
  const BugSnake({
    required this.body,
    required this.heading,
    required this.turns,
    required this.grow,
    required this.food,
    required this.bug,
    required this.bugLeft,
    required this.eaten,
    required this.bugs,
    required this.score,
    required this.seed,
    required this.over,
  });

  /// The caterpillar's cells, head first.
  final List<int> body;
  final SnakeHeading heading;

  /// Turns pressed but not yet crawled, at most two, so a quick double turn is not lost between ticks.
  final List<SnakeHeading> turns;

  /// Segments still to grow: the tail stays put a tick for each.
  final int grow;

  /// The seed's cell.
  final int food;

  /// The bug's cell while one is on the field, and the ticks before it flies off.
  final int? bug;
  final int bugLeft;

  /// Seeds and bugs eaten.
  final int eaten;
  final int bugs;
  final int score;

  /// The generator's state.
  final int seed;
  final BugSnakeEnd? over;

  BugSnake _with({List<int>? body, SnakeHeading? heading, List<SnakeHeading>? turns, BugSnakeEnd? over}) => BugSnake(
    body: body ?? this.body,
    heading: heading ?? this.heading,
    turns: turns ?? this.turns,
    grow: grow,
    food: food,
    bug: bug,
    bugLeft: bugLeft,
    eaten: eaten,
    bugs: bugs,
    score: score,
    seed: seed,
    over: over ?? this.over,
  );

  @override
  bool operator ==(Object other) =>
      other is BugSnake &&
      listEquals(other.body, body) &&
      other.heading == heading &&
      listEquals(other.turns, turns) &&
      other.grow == grow &&
      other.food == food &&
      other.bug == bug &&
      other.bugLeft == bugLeft &&
      other.eaten == eaten &&
      other.bugs == bugs &&
      other.score == score &&
      other.seed == seed &&
      other.over == over;

  @override
  int get hashCode => Object.hash(Object.hashAll(body), heading, Object.hashAll(turns), grow, food, bug, bugLeft, eaten, bugs, score, seed, over);
}

const seedPoints = 10;

/// A bug is worth this plus the ticks it had left.
const bugPoints = 20;

/// Ticks a bug stays on the field.
const bugTicks = 40;

/// A bug lands with every this many seeds eaten.
const _bugEvery = 5;
const _maxTurns = 2;

(int, int) _step(SnakeHeading h) => switch (h) {
  SnakeHeading.up => (0, -1),
  SnakeHeading.down => (0, 1),
  SnakeHeading.left => (-1, 0),
  SnakeHeading.right => (1, 0),
};

SnakeHeading _opposite(SnakeHeading h) => switch (h) {
  SnakeHeading.up => SnakeHeading.down,
  SnakeHeading.down => SnakeHeading.up,
  SnakeHeading.left => SnakeHeading.right,
  SnakeHeading.right => SnakeHeading.left,
};

/// A free cell (none of `taken`), drawn evenly from the free cells in order; -1 when there is none.
(int, int) _place(List<int> taken, int seed) {
  final free = [
    for (var c = 0; c < bugSnakeWidth * bugSnakeHeight; c++)
      if (!taken.contains(c)) c,
  ];
  if (free.isEmpty) return (-1, seed);
  final (r, s) = nextRandom(seed);
  return (free[(r * free.length).floor()], s);
}

/// A new run: three segments in the middle of the left half, heading right, and a seed somewhere.
BugSnake newBugSnake(int seed) {
  const row = bugSnakeHeight ~/ 2 * bugSnakeWidth;
  const body = [row + 5, row + 4, row + 3];
  final (food, s) = _place(body, seed);
  return BugSnake(
    body: body,
    heading: SnakeHeading.right,
    turns: const [],
    grow: 0,
    food: food,
    bug: null,
    bugLeft: 0,
    eaten: 0,
    bugs: 0,
    score: 0,
    seed: s,
    over: null,
  );
}

/// Milliseconds a tick: quicker as the caterpillar grows.
int bugSnakeStepMs(BugSnake g) => math.max(80, 200 - (g.body.length - 3) * 4);

/// Queues a turn. Turning back onto itself, or the way it already goes, is ignored.
BugSnake steerBugSnake(BugSnake g, SnakeHeading to) {
  if (g.over != null || g.turns.length >= _maxTurns) return g;
  final last = g.turns.isEmpty ? g.heading : g.turns.last;
  return to == last || to == _opposite(last) ? g : g._with(turns: [...g.turns, to]);
}

/// One tick: the next turn is taken, the head moves a cell, and the tail follows unless it is growing. A seed or a bug
/// under the head is eaten; the wall or the body under it ends the run. The tail's cell is free to move into, since it
/// moves away the same tick.
BugSnake crawlBugSnake(BugSnake g) {
  if (g.over != null) return g;
  final heading = g.turns.isEmpty ? g.heading : g.turns.first;
  final turns = g.turns.isEmpty ? g.turns : g.turns.sublist(1);
  final head = g.body.first;
  final (dx, dy) = _step(heading);
  final x = head % bugSnakeWidth + dx;
  final y = head ~/ bugSnakeWidth + dy;
  if (x < 0 || x >= bugSnakeWidth || y < 0 || y >= bugSnakeHeight) return g._with(heading: heading, turns: turns, over: BugSnakeEnd.wall);
  final to = y * bugSnakeWidth + x;
  final kept = g.grow > 0 ? g.body : g.body.sublist(0, g.body.length - 1);
  if (kept.contains(to)) return g._with(heading: heading, turns: turns, over: BugSnakeEnd.self);
  final body = [to, ...kept];
  var (grow, food, bug, bugLeft, eaten, bugs, score, seed) = (g.grow, g.food, g.bug, g.bugLeft, g.eaten, g.bugs, g.score, g.seed);
  if (grow > 0) grow--;
  if (bug != null && to == bug) {
    score += bugPoints + bugLeft;
    grow += 2;
    bugs++;
    (bug, bugLeft) = (null, 0);
  } else if (bug != null && --bugLeft <= 0) {
    (bug, bugLeft) = (null, 0);
  }
  BugSnakeEnd? over;
  if (to == food) {
    score += seedPoints;
    grow++;
    eaten++;
    (food, seed) = _place(bug == null ? body : [...body, bug], seed);
    if (food == -1) {
      over = BugSnakeEnd.full;
    } else if (eaten % _bugEvery == 0 && bug == null) {
      final (landed, s) = _place([...body, food], seed);
      seed = s;
      if (landed != -1) (bug, bugLeft) = (landed, bugTicks);
    }
  }
  return BugSnake(
    body: body,
    heading: heading,
    turns: turns,
    grow: grow,
    food: food,
    bug: bug,
    bugLeft: bugLeft,
    eaten: eaten,
    bugs: bugs,
    score: score,
    seed: seed,
    over: over,
  );
}
