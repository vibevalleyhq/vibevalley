import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'random.dart';

const mergeSize = 4;

/// A stage is worth 2^stage, as the tiles of 2048 are. Past the last, 丰收 counts on.
const mergeStages = ['种子', '芽', '叶', '花', '麦子', '胡萝卜', '麦捆', '一筐', '一车', '粮仓', '丰收'];

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

  /// 0 is empty, else the crop's stage.
  final List<int> board;
  final int score;
  final int moves;

  final int seed;

  /// -1 before any slide.
  final List<int> grown;
  final int sown;
  final bool over;

  /// One step back, no further.
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

String mergeStageName(int stage) => stage <= mergeGoal ? mergeStages[stage - 1] : '丰收${stage - mergeGoal + 1}';

int mergeTop(Merge g) => g.board.fold(0, math.max);

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

bool canSlide(List<int> board) {
  const n = mergeSize;
  for (var i = 0; i < board.length; i++) {
    if (board[i] == 0) return true;
    if (i % n < n - 1 && board[i] == board[i + 1]) return true;
    if (i + n < board.length && board[i] == board[i + n]) return true;
  }
  return false;
}

Merge newMerge(int seed) {
  final (one, _, s1) = _sow(List.filled(mergeSize * mergeSize, 0), seed);
  final (board, _, s2) = _sow(one, s1);
  return Merge(board: board, score: 0, moves: 0, seed: s2, grown: const [], sown: -1, over: false, previous: null);
}

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

/// The same slide again brings the same seed.
Merge undoMerge(Merge g) => g.previous ?? g;
