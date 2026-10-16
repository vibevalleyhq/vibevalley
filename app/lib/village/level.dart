// The village's layout, read from village.ldtk:
//   Ground (IntGrid, 4 px cells): 1 where feet can go. Plots and props are taken out by the game, so they can move.
//   Things (entities): Plot (index), Place (place, facing), Prop (spot, sprite), Area (spot; a box), Rest (n),
//   Light (r), Gate, Queue, Manager, Dog, Fx (kind). Points are where the entity stands (its pivot).

import 'dart:convert';

class Pt {
  const Pt(this.x, this.y);
  final double x;
  final double y;

  Pt operator +(Pt o) => Pt(x + o.x, y + o.y);
  @override
  String toString() => '($x, $y)';
}

typedef Box = ({double x0, double y0, double x1, double y1});

bool inBox(Pt p, Box b) => p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 && p.y < b.y1;

class Thing {
  const Thing(this.at, this.box, this._fields);
  final Pt at;
  final Box box;
  final Map<String, Object?> _fields;

  Object? field(String name) => _fields[name];
}

class Level {
  Level._(this.width, this.height, this._ground, this._gridSize, this._cols, this._rows, this._things);

  final double width;
  final double height;
  final List<int> _ground;
  final int _gridSize;
  final int _cols;
  final int _rows;
  final Map<String, List<Thing>> _things;

  static Level parse(String text) {
    final level = ((jsonDecode(text) as Map<String, dynamic>)['levels'] as List).first as Map<String, dynamic>;
    final layers = (level['layerInstances'] as List).cast<Map<String, dynamic>>();
    Map<String, dynamic> layer(String name) =>
        layers.firstWhere((l) => l['__identifier'] == name, orElse: () => throw StateError('village.ldtk: no layer $name'));
    final ground = layer('Ground');
    final things = <String, List<Thing>>{};
    for (final e in (layer('Things')['entityInstances'] as List).cast<Map<String, dynamic>>()) {
      final px = (e['px'] as List).cast<num>();
      final pivot = (e['__pivot'] as List).cast<num>();
      final w = (e['width'] as num).toDouble();
      final h = (e['height'] as num).toDouble();
      final x0 = px[0] - pivot[0] * w;
      final y0 = px[1] - pivot[1] * h;
      final fields = {for (final f in (e['fieldInstances'] as List).cast<Map<String, dynamic>>()) f['__identifier'] as String: f['__value']};
      things
          .putIfAbsent(e['__identifier'] as String, () => [])
          .add(Thing(Pt(px[0].toDouble(), px[1].toDouble()), (x0: x0, y0: y0, x1: x0 + w, y1: y0 + h), fields));
    }
    return Level._(
      (level['pxWid'] as num).toDouble(),
      (level['pxHei'] as num).toDouble(),
      (ground['intGridCsv'] as List).cast<int>(),
      ground['__gridSize'] as int,
      ground['__cWid'] as int,
      ground['__cHei'] as int,
      things,
    );
  }

  List<Thing> thingsOf(String kind) => _things[kind] ?? const [];

  Thing theThing(String kind) => thingsOf(kind).firstOrNull ?? (throw StateError('village.ldtk: no $kind'));

  /// Past the right edge the road goes on, as the edge column does.
  bool ground1(Pt p) {
    final cx = (p.x / _gridSize).floor().clamp(-1, _cols - 1);
    final cy = (p.y / _gridSize).floor();
    if (cx < 0 || cy < 0 || cy >= _rows) return false;
    return _ground[cy * _cols + cx] == 1;
  }
}
