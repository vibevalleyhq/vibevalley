// The phone's minigames as values (packages/core/test sokoban, blocks, dino ported): walls and pushes and undo in
// the warehouse; seven-bags, wall kicks, cleared rows and the end in 方块; jumps, ducks and speed in 小恐龙; and the
// seeded generator dealing exactly what the web page deals from the same seed.

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/phone/blocks.dart';
import 'package:vibevalley/phone/dino.dart';
import 'package:vibevalley/phone/sokoban.dart';

/// The pieces a game deals, in order, from its seed.
List<PieceKind> dealt(int seed, int n) {
  var g = newBlocks(seed);
  final out = <PieceKind>[];
  for (var i = 0; i < n; i++) {
    out.add(g.piece.kind);
    g = slam(g.copyWith(well: List.filled(blocksWidth * blocksHeight, 0)));
  }
  return out;
}

Dino runFor(Dino d, double ms, [double step = 16]) {
  var x = d;
  for (var t = 0.0; t < ms; t += step) {
    x = run(x, step);
  }
  return x;
}

Dino withObstacles(Dino d, List<Obstacle> obstacles, double gap) => d.copyWith(obstacles: obstacles, gap: gap);

void main() {
  group('推箱子', () {
    test('walls block movement; a push finishes the first puzzle and undo restores it', () {
      final g = newWarehouse();
      expect(identical(moveWarehouse(g, WarehouseDirection.left), g), isTrue);
      final next = moveWarehouse(g, WarehouseDirection.right);
      expect(warehouseDone(next), isTrue);
      expect(next.moves, 1);
      expect(next.pushes, 1);
      expect(identical(moveWarehouse(next, WarehouseDirection.down), next), isTrue);
      expect(undoWarehouse(next), g);
      expect(identical(undoWarehouse(g), g), isTrue);
      expect(newWarehouse(next.level), g);
    });

    test('boxes cannot be pushed through walls or each other; walking does not push', () {
      final g = newWarehouse(2);
      final width = warehouses[2].rows[0].length;
      final blocked = WarehouseGame(level: 2, player: width + 2, boxes: [width + 1, width + 3, width + 4], moves: 0, pushes: 0, history: const []);
      expect(identical(moveWarehouse(blocked, WarehouseDirection.left), blocked), isTrue);
      expect(identical(moveWarehouse(blocked, WarehouseDirection.right), blocked), isTrue);
      final walked = moveWarehouse(g, WarehouseDirection.down);
      expect(walked.moves, 1);
      expect(walked.pushes, 0);
      expect(undoWarehouse(walked), g);
    });

    test('every authored warehouse is rectangular, enclosed, and solvable', () {
      for (var level = 0; level < warehouses.length; level++) {
        final rows = warehouses[level].rows;
        expect(rows.every((r) => r.length == rows[0].length), isTrue);
        expect(rows.first.split('').every((c) => c == '#'), isTrue);
        expect(rows.last.split('').every((c) => c == '#'), isTrue);
        expect(rows.every((r) => r.startsWith('#') && r.endsWith('#')), isTrue);
        expect('@'.allMatches(rows.join()).length, 1);
        final g = newWarehouse(level);
        expect(g.boxes.length, '.'.allMatches(rows.join()).length);
        String key(WarehouseGame s) => '${s.player}:${([...s.boxes]..sort()).join(',')}';
        final queue = [g];
        final seen = {key(g)};
        var solved = false;
        for (var i = 0; i < queue.length && i < 80000; i++) {
          final current = queue[i];
          if (warehouseDone(current)) {
            solved = true;
            break;
          }
          for (final dir in WarehouseDirection.values) {
            final next = moveWarehouse(current, dir);
            if (seen.add(key(next))) {
              queue.add(WarehouseGame(level: next.level, player: next.player, boxes: next.boxes, moves: next.moves, pushes: next.pushes, history: const []));
            }
          }
        }
        expect(solved, isTrue, reason: 'level ${level + 1} must have a solution');
      }
    });
  });

  group('方块', () {
    test('a seed deals what the web page deals from it', () {
      // From packages/core blocks.ts with the same seeds (node, mulberry32 in 32-bit JS arithmetic).
      expect(dealt(42, 14).map((k) => k.name).join(), 'SOIJLTZTJILZSO');
      expect(newBlocks(42).seed, -1895506968);
      expect(newBlocks(123456789).seed, -1772050221);
    });

    test('a seed deals the same pieces again; every seven are one of each', () {
      expect(dealt(42, 14), dealt(42, 14));
      final pieces = dealt(7, 14);
      expect(pieces.sublist(0, 7).toSet(), PieceKind.values.toSet());
      expect(pieces.sublist(7, 14).toSet(), PieceKind.values.toSet());
    });

    test('the walls stop a piece; a turn against a wall is nudged off it', () {
      var g = newBlocks(1).copyWith(piece: const Falling(kind: PieceKind.T, turn: 0, x: 3, y: 0));
      for (var i = 0; i < 20; i++) {
        g = shift(g, -1);
      }
      expect(cellsOf(g.piece).map((c) => c.$1).reduce((a, b) => a < b ? a : b), 0);
      // An upright I on the right wall turns flat by stepping left.
      final upright = g.copyWith(
        piece: const Falling(kind: PieceKind.I, turn: 1, x: blocksWidth - 3, y: 2),
      );
      final flat = turn(upright);
      expect(flat.piece.turn, 2);
      expect(cellsOf(flat.piece).every((c) => c.$1 < blocksWidth), isTrue);
    });

    test('a full row clears, the rows above fall, and it scores by the level', () {
      final well = List.filled(blocksWidth * blocksHeight, 0);
      // The bottom row full but for its last four cells, and one block above it.
      for (var x = 0; x < blocksWidth - 4; x++) {
        well[(blocksHeight - 1) * blocksWidth + x] = 1;
      }
      well[(blocksHeight - 2) * blocksWidth] = 3;
      final g = newBlocks(3).copyWith(
        well: well,
        level: 2,
        piece: const Falling(kind: PieceKind.I, turn: 0, x: blocksWidth - 4, y: 0),
      );
      final after = slam(g);
      expect(after.lines, 1);
      expect(after.score, (blocksHeight - 2) * 2 + 100 * 2, reason: 'two a row dropped, 100 a line at level 2');
      expect(after.well[(blocksHeight - 1) * blocksWidth], 3, reason: 'the block above fell into the cleared row');
      expect(after.well.where((c) => c != 0).length, 1);
    });

    test('a piece falls a row a tick, then lands; ten lines are the next level', () {
      final g = newBlocks(5).copyWith(piece: const Falling(kind: PieceKind.O, turn: 0, x: 4, y: 0));
      expect(fall(g).piece.y, 1);
      var h = g;
      for (var i = 0; i < blocksHeight; i++) {
        h = fall(h);
      }
      expect(h.well.where((c) => c != 0).length, 4, reason: 'the O landed');
      expect(slam(newBlocks(5).copyWith(lines: 9)).level, 1);
      expect(fallMs(1), 800);
      expect(fallMs(20), 90);
    });

    test('a stack to the top ends the game, and nothing moves after', () {
      final well = List.filled(blocksWidth * blocksHeight, 0);
      // A column in the middle up to the second row: the next piece has no room.
      for (var y = 1; y < blocksHeight; y++) {
        for (final x in [3, 4, 5, 6]) {
          well[y * blocksWidth + x] = 2;
        }
      }
      final over = slam(
        newBlocks(9).copyWith(
          well: well,
          piece: const Falling(kind: PieceKind.O, turn: 0, x: 0, y: 0),
        ),
      );
      expect(over.over, isTrue);
      expect(identical(shift(over, 1), over), isTrue);
      expect(identical(fall(over), over), isTrue);
    });
  });

  group('小恐龙', () {
    test('a jump rises, peaks and lands; only from the ground', () {
      final up = run(jump(newDino(1)), 100);
      expect(up.lift, greaterThan(8));
      expect(jump(up).rise, up.rise, reason: 'no second jump in the air');
      expect(runFor(up, 1200).lift, 0);
    });

    test('a cactus ends a run on the ground; jumped in time, it passes under', () {
      const cactus = Obstacle(kind: ObstacleKind.cactus, x: 22, y: dinoGround - 12, w: 6, h: 12);
      final standing = withObstacles(newDino(2), [cactus], 999);
      expect(runFor(standing, 400).over, isTrue);
      final jumped = runFor(jump(withObstacles(standing, [cactus.at(26)], 999)), 400);
      expect(jumped.over, isFalse);
    });

    test('a high bird is ducked under', () {
      const bird = Obstacle(kind: ObstacleKind.bird, x: 22, y: dinoGround - 18, w: 12, h: 8);
      final running = withObstacles(newDino(3), [bird], 999);
      expect(runFor(running, 400).over, isTrue);
      expect(runFor(duck(running, true), 400).over, isFalse);
    });

    test('obstacles keep coming, the ground speeds up, the score is the distance; a seed replays', () {
      final long = runFor(newDino(4), 3000);
      expect(long.speed, greaterThan(newDino(4).speed));
      expect(dinoScore(long), (long.distance / 10).floor());
      expect(runFor(newDino(4), 3000), long);
      final ended = long.copyWith(over: true);
      expect(identical(run(ended, 100), ended), isTrue);
    });

    test('a seed runs what the web page runs from it', () {
      // From packages/core dino.ts with the same seed and steps (node).
      final d = runFor(newDino(4), 3000);
      expect(d.seed, -1263671336);
      expect(d.distance, closeTo(130.11089789109818, 1e-9));
      expect(d.over, isTrue);
      expect(d.obstacles.map((o) => o.kind), [ObstacleKind.cacti, ObstacleKind.cactus]);
      var e = jump(newDino(99));
      for (var t = 0.0; t < 20000; t += 16) {
        e = run(e.lift == 0 ? jump(e) : e, 16);
      }
      expect(e.seed, -1263671241);
      expect(e.distance, closeTo(244.85414448225558, 1e-9));
      expect(e.time, 3024);
    });

    test('every obstacle can be jumped at the starting speed, with a fair moment to jump', () {
      const kinds = [
        Obstacle(kind: ObstacleKind.cactus, x: 0, y: dinoGround - 12, w: 6, h: 12),
        Obstacle(kind: ObstacleKind.cacti, x: 0, y: dinoGround - 10, w: 12, h: 10),
        Obstacle(kind: ObstacleKind.bird, x: 0, y: dinoGround - 12, w: 12, h: 8),
      ];
      for (final o in kinds) {
        var clear = 0;
        for (var ahead = 10; ahead <= 80; ahead++) {
          final start = withObstacles(newDino(1), [o.at(8.0 + ahead)], 9999);
          if (!runFor(jump(start), 1500).over) clear++;
        }
        expect(clear, greaterThanOrEqualTo(10), reason: '${o.kind}: only $clear pixels of distance to jump from');
      }
    });
  });
}
