// Pure: a game is a value, each move a function to the next. Pieces come from a seven-bag drawn with the game's own seeded generator, so a seed replays.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'random.dart';

const blocksWidth = 10;
const blocksHeight = 18;

/// The seven pieces, in the order the well's marks count them; named by their letters, as everyone calls them.
// ignore: constant_identifier_names
enum PieceKind { I, O, T, S, Z, J, L }

const Map<PieceKind, (int, List<(int, int)>)> _shapes = {
  PieceKind.I: (4, [(0, 1), (1, 1), (2, 1), (3, 1)]),
  PieceKind.O: (2, [(0, 0), (1, 0), (0, 1), (1, 1)]),
  PieceKind.T: (3, [(1, 0), (0, 1), (1, 1), (2, 1)]),
  PieceKind.S: (3, [(1, 0), (2, 0), (0, 1), (1, 1)]),
  PieceKind.Z: (3, [(0, 0), (1, 0), (1, 1), (2, 1)]),
  PieceKind.J: (3, [(0, 0), (0, 1), (1, 1), (2, 1)]),
  PieceKind.L: (3, [(2, 0), (0, 1), (1, 1), (2, 1)]),
};

class Falling {
  const Falling({required this.kind, required this.turn, required this.x, required this.y});
  final PieceKind kind;

  /// 0..3.
  final int turn;

  final int x;
  final int y;

  Falling copyWith({int? turn, int? x, int? y}) => Falling(kind: kind, turn: turn ?? this.turn, x: x ?? this.x, y: y ?? this.y);

  @override
  bool operator ==(Object other) => other is Falling && other.kind == kind && other.turn == turn && other.x == x && other.y == y;

  @override
  int get hashCode => Object.hash(kind, turn, x, y);
}

class Blocks {
  const Blocks({
    required this.well,
    required this.piece,
    required this.next,
    required this.bag,
    required this.seed,
    required this.score,
    required this.lines,
    required this.level,
    required this.over,
  });

  /// Row by row from the top: 0 is empty, else 1 + the index of the piece that left it (PieceKind).
  final List<int> well;
  final Falling piece;
  final PieceKind next;

  final List<PieceKind> bag;

  final int seed;
  final int score;
  final int lines;
  final int level;
  final bool over;

  Blocks copyWith({List<int>? well, Falling? piece, int? score, int? lines, int? level}) => Blocks(
    well: well ?? this.well,
    piece: piece ?? this.piece,
    next: next,
    bag: bag,
    seed: seed,
    score: score ?? this.score,
    lines: lines ?? this.lines,
    level: level ?? this.level,
    over: over,
  );

  @override
  bool operator ==(Object other) =>
      other is Blocks &&
      listEquals(other.well, well) &&
      other.piece == piece &&
      other.next == next &&
      listEquals(other.bag, bag) &&
      other.seed == seed &&
      other.score == score &&
      other.lines == lines &&
      other.level == level &&
      other.over == over;

  @override
  int get hashCode => Object.hash(Object.hashAll(well), piece, next, Object.hashAll(bag), seed, score, lines, level, over);
}

List<(int, int)> cellsOf(Falling p) {
  final (size, cells) = _shapes[p.kind]!;
  return [
    for (final (cx, cy) in cells)
      () {
        var (x, y) = (cx, cy);
        for (var i = 0; i < p.turn; i++) {
          (x, y) = (size - 1 - y, x);
        }
        return (p.x + x, p.y + y);
      }(),
  ];
}

(PieceKind, List<PieceKind>, int) _draw(List<PieceKind> bag, int seed) {
  if (bag.isNotEmpty) return (bag[0], bag.sublist(1), seed);
  final fresh = [...PieceKind.values];
  var s = seed;
  for (var i = fresh.length - 1; i > 0; i--) {
    final (r, n) = nextRandom(s);
    s = n;
    final j = (r * (i + 1)).floor();
    final swap = fresh[i];
    fresh[i] = fresh[j];
    fresh[j] = swap;
  }
  return (fresh[0], fresh.sublist(1), s);
}

Falling _spawn(PieceKind kind) => Falling(kind: kind, turn: 0, x: (blocksWidth - _shapes[kind]!.$1) ~/ 2, y: 0);

/// Above the top is fine.
bool fits(List<int> well, Falling p) =>
    cellsOf(p).every((c) => c.$1 >= 0 && c.$1 < blocksWidth && c.$2 < blocksHeight && (c.$2 < 0 || well[c.$2 * blocksWidth + c.$1] == 0));

Blocks newBlocks(int seed) {
  final (first, bag1, s1) = _draw(const [], seed);
  final (next, bag2, s2) = _draw(bag1, s1);
  return Blocks(
    well: List.filled(blocksWidth * blocksHeight, 0),
    piece: _spawn(first),
    next: next,
    bag: bag2,
    seed: s2,
    score: 0,
    lines: 0,
    level: 1,
    over: false,
  );
}

const _linePoints = [0, 100, 300, 500, 800];

/// In milliseconds.
int fallMs(int level) => math.max(90, 800 - (level - 1) * 70);

Blocks shift(Blocks g, int dx) {
  if (g.over) return g;
  final moved = g.piece.copyWith(x: g.piece.x + dx);
  return fits(g.well, moved) ? g.copyWith(piece: moved) : g;
}

/// Nudged off a wall or a stack (one, then two cells either way) when it would not fit.
Blocks turn(Blocks g) {
  if (g.over) return g;
  final turned = g.piece.copyWith(turn: (g.piece.turn + 1) % 4);
  for (final dx in const [0, -1, 1, -2, 2]) {
    final kicked = turned.copyWith(x: turned.x + dx);
    if (fits(g.well, kicked)) return g.copyWith(piece: kicked);
  }
  return g;
}

Blocks fall(Blocks g) {
  if (g.over) return g;
  final lower = g.piece.copyWith(y: g.piece.y + 1);
  return fits(g.well, lower) ? g.copyWith(piece: lower) : _land(g);
}

/// Two points for each row dropped.
Blocks slam(Blocks g) {
  if (g.over) return g;
  var p = g.piece;
  var rows = 0;
  while (fits(g.well, p.copyWith(y: p.y + 1))) {
    p = p.copyWith(y: p.y + 1);
    rows++;
  }
  return _land(g.copyWith(piece: p, score: g.score + rows * 2));
}

Falling landingOf(Blocks g) {
  var p = g.piece;
  while (fits(g.well, p.copyWith(y: p.y + 1))) {
    p = p.copyWith(y: p.y + 1);
  }
  return p;
}

Blocks _land(Blocks g) {
  final well = [...g.well];
  final mark = g.piece.kind.index + 1;
  var above = false;
  for (final (x, y) in cellsOf(g.piece)) {
    if (y < 0) {
      above = true;
    } else {
      well[y * blocksWidth + x] = mark;
    }
  }
  final kept = <int>[];
  var cleared = 0;
  for (var y = 0; y < blocksHeight; y++) {
    final row = well.sublist(y * blocksWidth, (y + 1) * blocksWidth);
    if (row.every((c) => c != 0)) {
      cleared++;
    } else {
      kept.addAll(row);
    }
  }
  final settled = [...List.filled(cleared * blocksWidth, 0), ...kept];
  final lines = g.lines + cleared;
  final (after, bag, seed) = _draw(g.bag, g.seed);
  final piece = _spawn(g.next);
  return Blocks(
    well: settled,
    piece: piece,
    next: after,
    bag: bag,
    seed: seed,
    score: g.score + _linePoints[cleared] * g.level,
    lines: lines,
    level: 1 + lines ~/ 10,
    over: above || !fits(settled, piece),
  );
}
