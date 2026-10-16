import 'package:flutter/foundation.dart';

class Warehouse {
  const Warehouse(this.name, this.rows);
  final String name;

  /// `#` wall, `.` goal, `$` box, `@` the player, space floor; every row the same length.
  final List<String> rows;
}

const warehouses = [
  Warehouse('第一箱种子', ['######', '#    #', r'#@$. #', '#    #', '######']),
  Warehouse('绕到后面', ['#######', '#     #', r'# .$  #', '#  #@ #', '#     #', '#######']),
  Warehouse('两箱收成', ['#######', '# . . #', r'# $ $ #', '#  @  #', '#     #', '#######']),
  Warehouse('仓库拐角', ['#######', '# .   #', r'# $   #', r'#   $ #', '# # . #', '#  @  #', '#######']),
  Warehouse('丰收入仓', ['########', '# . . .#', r'# $ $ $#', '#      #', '#  @   #', '########']),
];

enum WarehouseDirection { left, right, up, down }

/// Cells are indexes into the warehouse's rows joined.
class WarehousePosition {
  const WarehousePosition({required this.player, required this.boxes, required this.moves, required this.pushes});
  final int player;
  final List<int> boxes;
  final int moves;
  final int pushes;

  @override
  bool operator ==(Object other) =>
      other is WarehousePosition && other.player == player && listEquals(other.boxes, boxes) && other.moves == moves && other.pushes == pushes;

  @override
  int get hashCode => Object.hash(player, Object.hashAll(boxes), moves, pushes);
}

class WarehouseGame {
  const WarehouseGame({required this.level, required this.player, required this.boxes, required this.moves, required this.pushes, required this.history});
  final int level;
  final int player;
  final List<int> boxes;
  final int moves;
  final int pushes;
  final List<WarehousePosition> history;

  @override
  bool operator ==(Object other) =>
      other is WarehouseGame &&
      other.level == level &&
      other.player == player &&
      listEquals(other.boxes, boxes) &&
      other.moves == moves &&
      other.pushes == pushes &&
      listEquals(other.history, history);

  @override
  int get hashCode => Object.hash(level, player, Object.hashAll(boxes), moves, pushes, Object.hashAll(history));
}

String _cells(int level) => warehouses[level].rows.join();

WarehouseGame newWarehouse([int level = 0]) {
  final chosen = level >= 0 && level < warehouses.length ? level : 0;
  final cells = _cells(chosen);
  return WarehouseGame(
    level: chosen,
    player: cells.indexOf('@'),
    boxes: [
      for (var i = 0; i < cells.length; i++)
        if (cells[i] == r'$') i,
    ],
    moves: 0,
    pushes: 0,
    history: const [],
  );
}

bool warehouseDone(WarehouseGame g) {
  final cells = _cells(g.level);
  return g.boxes.every((box) => cells[box] == '.');
}

/// `g` itself when nothing moves.
WarehouseGame moveWarehouse(WarehouseGame g, WarehouseDirection direction) {
  if (warehouseDone(g)) return g;
  final rows = warehouses[g.level].rows;
  final width = rows[0].length;
  final cells = rows.join();
  final offset = switch (direction) {
    WarehouseDirection.left => -1,
    WarehouseDirection.right => 1,
    WarehouseDirection.up => -width,
    WarehouseDirection.down => width,
  };
  int? step(int from) {
    final next = from + offset;
    if (next < 0 || next >= cells.length || cells[next] == '#') return null;
    if ((direction == WarehouseDirection.left || direction == WarehouseDirection.right) && from ~/ width != next ~/ width) return null;
    return next;
  }

  final player = step(g.player);
  if (player == null) return g;
  final box = g.boxes.indexOf(player);
  var boxes = g.boxes;
  if (box >= 0) {
    final target = step(player);
    if (target == null || g.boxes.contains(target)) return g;
    boxes = [for (var i = 0; i < g.boxes.length; i++) i == box ? target : g.boxes[i]];
  }
  final previous = WarehousePosition(player: g.player, boxes: g.boxes, moves: g.moves, pushes: g.pushes);
  return WarehouseGame(
    level: g.level,
    player: player,
    boxes: boxes,
    moves: g.moves + 1,
    pushes: g.pushes + (box < 0 ? 0 : 1),
    history: [...g.history, previous],
  );
}

WarehouseGame undoWarehouse(WarehouseGame g) {
  if (g.history.isEmpty) return g;
  final p = g.history.last;
  return WarehouseGame(level: g.level, player: p.player, boxes: p.boxes, moves: p.moves, pushes: p.pushes, history: g.history.sublist(0, g.history.length - 1));
}
