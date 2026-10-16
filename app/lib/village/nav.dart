import 'dart:math' as math;
import 'dart:typed_data';

import 'level.dart';

const _sqrt2 = math.sqrt2;

class NavMap {
  NavMap({required double w, required double h, double cell = 8, required bool Function(Pt) walkable, double clearance = 24})
    : _cell = cell,
      _cols = (w / cell).ceil(),
      _rows = (h / cell).ceil() {
    final n = _cols * _rows;
    _free = Uint8List(n);
    for (var i = 0; i < n; i++) {
      _free[i] = walkable(_centre(i)) ? 1 : 0;
    }
    // A two-pass chamfer distance.
    final far = Float32List(n);
    for (var i = 0; i < n; i++) {
      far[i] = _free[i] == 1 ? 1e9 : 0;
    }
    void relax(int i, int j, double d) {
      if (far[j] + d < far[i]) far[i] = far[j] + d;
    }

    for (var r = 0; r < _rows; r++) {
      for (var c = 0; c < _cols; c++) {
        final i = r * _cols + c;
        if (c > 0) relax(i, i - 1, 1);
        if (r > 0) {
          relax(i, i - _cols, 1);
          if (c > 0) relax(i, i - _cols - 1, _sqrt2);
          if (c < _cols - 1) relax(i, i - _cols + 1, _sqrt2);
        }
      }
    }
    for (var r = _rows - 1; r >= 0; r--) {
      for (var c = _cols - 1; c >= 0; c--) {
        final i = r * _cols + c;
        if (c < _cols - 1) relax(i, i + 1, 1);
        if (r < _rows - 1) {
          relax(i, i + _cols, 1);
          if (c < _cols - 1) relax(i, i + _cols + 1, _sqrt2);
          if (c > 0) relax(i, i + _cols - 1, _sqrt2);
        }
      }
    }
    final room = clearance / cell;
    _weight = Float32List(n);
    for (var i = 0; i < n; i++) {
      _weight[i] = 1 + (far[i] < room ? (room - far[i]) / room : 0);
    }
    _g = Float32List(n);
    _came = Int32List(n);
    _closed = Uint8List(n);
  }

  final double _cell;
  final int _cols;
  final int _rows;
  late final Uint8List _free;
  late final Float32List _weight;
  late final Float32List _g;
  late final Int32List _came;
  late final Uint8List _closed;
  final _heap = _MinHeap();

  Pt _centre(int i) => Pt(((i % _cols) + 0.5) * _cell, ((i ~/ _cols) + 0.5) * _cell);

  int _index(Pt p) {
    final c = (p.x / _cell).floor().clamp(0, _cols - 1);
    final r = (p.y / _cell).floor().clamp(0, _rows - 1);
    return r * _cols + c;
  }

  bool walkable(Pt p) => _free[_index(p)] == 1;

  int _nearestFree(int i) {
    if (_free[i] == 1) return i;
    final c0 = i % _cols;
    final r0 = i ~/ _cols;
    for (var ring = 1; ring < math.max(_cols, _rows); ring++) {
      var best = -1;
      var bestD = double.infinity;
      for (var r = r0 - ring; r <= r0 + ring; r++) {
        for (var c = c0 - ring; c <= c0 + ring; c++) {
          if (r < 0 || c < 0 || r >= _rows || c >= _cols) continue;
          if (math.max((r - r0).abs(), (c - c0).abs()) != ring) continue;
          final j = r * _cols + c;
          final d = ((r - r0) * (r - r0) + (c - c0) * (c - c0)).toDouble();
          if (_free[j] == 1 && d < bestD) {
            best = j;
            bestD = d;
          }
        }
      }
      if (best >= 0) return best;
    }
    return i;
  }

  List<int>? _search(int start, int goal) {
    _g.fillRange(0, _g.length, double.infinity);
    _came.fillRange(0, _came.length, -1);
    _closed.fillRange(0, _closed.length, 0);
    _heap.clear();
    final gc = goal % _cols;
    final gr = goal ~/ _cols;
    double h(int i) {
      final dx = ((i % _cols) - gc).abs();
      final dy = ((i ~/ _cols) - gr).abs();
      return math.max(dx, dy) + (_sqrt2 - 1) * math.min(dx, dy);
    }

    _g[start] = 0;
    _heap.push(start, h(start));
    while (_heap.size > 0) {
      final i = _heap.pop();
      if (i == goal) {
        final cells = [i];
        for (var k = _came[i]; k >= 0; k = _came[k]) {
          cells.add(k);
        }
        return cells.reversed.toList();
      }
      if (_closed[i] == 1) continue;
      _closed[i] = 1;
      final c = i % _cols;
      final r = i ~/ _cols;
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (dr == 0 && dc == 0) continue;
          final nc = c + dc;
          final nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= _cols || nr >= _rows) continue;
          final j = nr * _cols + nc;
          if (_free[j] == 0 || _closed[j] == 1) continue;
          // No squeezing diagonally between two blocked cells.
          if (dr != 0 && dc != 0 && (_free[r * _cols + nc] == 0 || _free[nr * _cols + c] == 0)) continue;
          final step = (dr != 0 && dc != 0 ? _sqrt2 : 1) * (_weight[i] + _weight[j]) * 0.5;
          final tentative = _g[i] + step;
          if (tentative < _g[j]) {
            _g[j] = tentative;
            _came[j] = i;
            _heap.push(j, tentative + h(j));
          }
        }
      }
    }
    return null;
  }

  double _lineCost(Pt a, Pt b) {
    final length = math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    final steps = math.max(1, (length / (_cell * 0.5)).ceil());
    var sum = 0.0;
    for (var s = 0; s <= steps; s++) {
      final i = _index(Pt(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps));
      if (_free[i] == 0) return double.infinity;
      sum += _weight[i];
    }
    return (sum / (steps + 1)) * (length / _cell);
  }

  /// The ends may sit off the grid's walkable cells (they were snapped there), so never infinity.
  double _stepCost(Pt a, Pt b) {
    final c = _lineCost(a, b);
    return c.isFinite ? c : math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)) / _cell;
  }

  /// Unreachable: straight there.
  List<Pt> route(Pt from, Pt to) {
    final cells = _search(_nearestFree(_index(from)), _nearestFree(_index(to)));
    if (cells == null) return [from, to];
    final points = cells.map(_centre).toList();
    points[0] = from;
    points[points.length - 1] = to;
    final spent = [0.0];
    for (var k = 1; k < points.length; k++) {
      spent.add(spent[k - 1] + _stepCost(points[k - 1], points[k]));
    }
    // Cut corners: from each kept point, jump to the farthest one a straight line reaches no dearer.
    final kept = [points[0]];
    var at = 0;
    while (at < points.length - 1) {
      var next = at + 1;
      for (var k = points.length - 1; k > at + 1; k--) {
        if (_lineCost(points[at], points[k]) <= (spent[k] - spent[at]) * 1.03) {
          next = k;
          break;
        }
      }
      kept.add(points[next]);
      at = next;
    }
    return kept;
  }
}

class _MinHeap {
  final _items = <int>[];
  final _keys = <double>[];

  int get size => _items.length;

  void clear() {
    _items.clear();
    _keys.clear();
  }

  void push(int item, double key) {
    var i = _items.length;
    _items.add(item);
    _keys.add(key);
    while (i > 0) {
      final parent = (i - 1) >> 1;
      if (_keys[parent] <= key) break;
      _items[i] = _items[parent];
      _keys[i] = _keys[parent];
      i = parent;
    }
    _items[i] = item;
    _keys[i] = key;
  }

  /// -1 when empty.
  int pop() {
    if (_items.isEmpty) return -1;
    final top = _items[0];
    final lastItem = _items.removeLast();
    final lastKey = _keys.removeLast();
    if (_items.isNotEmpty) {
      var i = 0;
      while (true) {
        final left = i * 2 + 1;
        if (left >= _items.length) break;
        final right = left + 1;
        final child = right < _items.length && _keys[right] < _keys[left] ? right : left;
        if (_keys[child] >= lastKey) break;
        _items[i] = _items[child];
        _keys[i] = _keys[child];
        i = child;
      }
      _items[i] = lastItem;
      _keys[i] = lastKey;
    }
    return top;
  }
}

class Walker {
  Walker(Pt from, this.speed, this._route) : x = from.x, y = from.y, _target = from;

  double x;
  double y;
  String facing = 'down';
  final double speed;
  final List<Pt> Function(Pt from, Pt to) _route;
  List<Pt> _path = [];
  Pt _target;

  bool get walking => _path.isNotEmpty;

  void go(Pt to) {
    if ((to.x - _target.x).abs() < 0.5 && (to.y - _target.y).abs() < 0.5) return;
    _target = to;
    _path = _route(Pt(x, y), to).skip(1).toList();
  }

  void step(double dt) {
    var left = speed * dt;
    while (left > 0 && _path.isNotEmpty) {
      final next = _path.first;
      final dx = next.x - x;
      final dy = next.y - y;
      final d = math.sqrt(dx * dx + dy * dy);
      if (d > 0.01) facing = dx.abs() > dy.abs() ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (d <= left) {
        x = next.x;
        y = next.y;
        _path.removeAt(0);
        left -= d;
      } else {
        x += dx / d * left;
        y += dy / d * left;
        left = 0;
      }
    }
  }
}

int frameAt(double t, int frames, double fps) => (t * fps).floor() % frames;
