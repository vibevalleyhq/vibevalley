// 种田 2048: the farm phone's sliding game (packages/core/src/merge.ts). A 4×4 field of crops, each a growth stage; a
// slide pushes every crop as far as it goes one way, two of the same stage that meet grow into the next (once a
// slide), and a seed comes up on an empty cell. 丰收 (the eleventh stage, 2048) wins; the run ends when no slide changes
// the field. Pure, like blocks.dart: a game is a value and each slide a function to the next; the phone draws it
// (merge_game.dart). Seeds land from the game's own seeded generator, so a seed replays, the same as on the web page.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'random.dart';

const mergeSize = 4;

/// The stages, from 1: a stage is worth 2^stage, as the tiles of 2048 are. Past the last, 丰收 counts on.
const mergeStages = ['种子', '芽', '叶', '花', '麦子', '胡萝卜', '麦捆', '一筐', '一车', '粮仓', '丰收'];

/// The stage that wins: 丰收, 2048.
const mergeGoal = 11;

enum MergeDirection { left, right, up, down }

class Merge {
  const Merge({
    required this.board,
    required this.score,
    required this.moves,
    required this.seed,
    required this.grown,
    required this.sown,
    required this.over,
    required this.previous,
  });

  /// Row by row from the top: 0 is empty, else the crop's stage.
  final List<int> board;
  final int score;
  final int moves;

  /// The generator's state.
  final int seed;

  /// The cells that grew on the last slide, and where its seed came up (-1 before any slide).
  final List<int> grown;
  final int sown;
  final bool over;

  /// The game before the last slide: one step back, no further.
  final Merge? previous;

  Merge copyWith({List<int>? board, int? score, int? moves, int? seed, List<int>? grown, int? sown, bool? over, Merge? Function()? previous}) => Merge(
    board: board ?? this.board,
    score: score ?? this.score,
    moves: moves ?? this.moves,
    seed: seed ?? this.seed,
    grown: grown ?? this.grown,
    sown: sown ?? this.sown,
    over: over ?? this.over,
    previous: previous != null ? previous() : this.previous,
  );

  @override
  bool operator ==(Object other) =>
      other is Merge &&
      listEquals(other.board, board) &&
      other.score == score &&
      other.moves == moves &&
      other.seed == seed &&
      listEquals(other.grown, grown) &&
      other.sown == sown &&
      other.over == over &&
      other.previous == previous;

  @override
  int get hashCode => Object.hash(Object.hashAll(board), score, moves, seed, Object.hashAll(grown), sown, over, previous);
}

/// A stage's name; past 丰收 it counts: 丰收2, 丰收3.
String mergeStageName(int stage) => stage <= mergeGoal ? mergeStages[stage - 1] : '丰收${stage - mergeGoal + 1}';

/// The highest stage on the field.
int mergeTop(Merge g) => g.board.fold(0, math.max);

/// A seed on one of the empty cells, picked by the generator; the board unchanged when it is full.
(List<int>, int, int) _sow(List<int> board, int seed) {
  final empty = [
    for (var i = 0; i < board.length; i++)
      if (board[i] == 0) i,
  ];
  if (empty.isEmpty) return ([...board], -1, seed);
  final (r, s) = nextRandom(seed);
  final at = empty[(r * empty.length).floor()];
  final next = [...board];
  next[at] = 1;
  return (next, at, s);
}

/// The cells of each line, in order from the edge the crops slide to.
List<List<int>> _lines(MergeDirection direction) {
  const n = mergeSize;
  return [
    for (var a = 0; a < n; a++)
      [
        for (var b = 0; b < n; b++)
          switch (direction) {
            MergeDirection.left => a * n + b,
            MergeDirection.right => a * n + (n - 1 - b),
            MergeDirection.up => b * n + a,
            MergeDirection.down => (n - 1 - b) * n + a,
          },
      ],
  ];
}

/// Whether some slide would change the field: an empty cell, or two of a stage side by side.
bool canSlide(List<int> board) {
  const n = mergeSize;
  for (var i = 0; i < board.length; i++) {
    if (board[i] == 0) return true;
    if (i % n < n - 1 && board[i] == board[i + 1]) return true;
    if (i + n < board.length && board[i] == board[i + n]) return true;
  }
  return false;
}

/// A new field with two seeds on it.
Merge newMerge(int seed) {
  final (one, _, s1) = _sow(List.filled(mergeSize * mergeSize, 0), seed);
  final (board, _, s2) = _sow(one, s1);
  return Merge(board: board, score: 0, moves: 0, seed: s2, grown: const [], sown: -1, over: false, previous: null);
}

/// Slides every crop one way; pairs that meet grow, scoring the new stage's worth, and a seed comes up. The same game
/// back when nothing would move, or the run is over.
Merge slideMerge(Merge g, MergeDirection direction) {
  if (g.over) return g;
  final board = [...g.board];
  final grown = <int>[];
  var gained = 0;
  for (final line in _lines(direction)) {
    final crops = [
      for (final i in line)
        if (g.board[i] != 0) g.board[i],
    ];
    final out = <int>[];
    for (var k = 0; k < crops.length; k++) {
      if (k + 1 < crops.length && crops[k] == crops[k + 1]) {
        final stage = crops[k] + 1;
        grown.add(line[out.length]);
        out.add(stage);
        gained += 1 << stage;
        k++;
      } else {
        out.add(crops[k]);
      }
    }
    for (var k = 0; k < line.length; k++) {
      board[line[k]] = k < out.length ? out[k] : 0;
    }
  }
  if (listEquals(board, g.board)) return g;
  final (sown, at, seed) = _sow(board, g.seed);
  return Merge(
    board: sown,
    score: g.score + gained,
    moves: g.moves + 1,
    seed: seed,
    grown: grown,
    sown: at,
    over: !canSlide(sown),
    previous: g.copyWith(previous: () => null),
  );
}

/// One slide back, seed and all (so the same slide again brings the same seed); only once in a row.
Merge undoMerge(Merge g) => g.previous ?? g;
