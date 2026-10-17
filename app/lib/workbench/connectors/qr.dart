// A port of Project Nayuki's QR Code generator (MIT): byte segments only, versions 1 to 40, the mask with the lowest penalty. The connectors' pages draw the
// codes as the qrcode package does: byte mode, error correction M, a one-module margin.

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

enum QrEcc {
  low(1),
  medium(0),
  quartile(3),
  high(2);

  const QrEcc(this.formatBits);
  final int formatBits;
}

// Per level (L, M, Q, H) and version (index 0 unused): codewords of error correction per block, and the number of blocks.
const _eccPerBlock = [
  [
    -1,
    7,
    10,
    15,
    20,
    26,
    18,
    20,
    24,
    30,
    18,
    20,
    24,
    26,
    30,
    22,
    24,
    28,
    30,
    28,
    28,
    28,
    28,
    30,
    30,
    26,
    28,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
  ],
  [
    -1,
    10,
    16,
    26,
    18,
    24,
    16,
    18,
    22,
    22,
    26,
    30,
    22,
    22,
    24,
    24,
    28,
    28,
    26,
    26,
    26,
    26,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
    28,
  ],
  [
    -1,
    13,
    22,
    18,
    26,
    18,
    24,
    18,
    22,
    20,
    24,
    28,
    26,
    24,
    20,
    30,
    24,
    28,
    28,
    26,
    30,
    28,
    30,
    30,
    30,
    30,
    28,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
  ],
  [
    -1,
    17,
    28,
    22,
    16,
    22,
    28,
    26,
    26,
    24,
    28,
    24,
    28,
    22,
    24,
    24,
    30,
    28,
    28,
    26,
    28,
    30,
    24,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
    30,
  ],
];
const _numBlocks = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

int _row(QrEcc e) => switch (e) {
  QrEcc.low => 0,
  QrEcc.medium => 1,
  QrEcc.quartile => 2,
  QrEcc.high => 3,
};

int _rawModules(int ver) {
  var result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    final numAlign = ver ~/ 7 + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

int _dataCodewords(int ver, QrEcc ecl) => _rawModules(ver) ~/ 8 - _eccPerBlock[_row(ecl)][ver] * _numBlocks[_row(ecl)][ver];

bool _bit(int x, int i) => ((x >> i) & 1) != 0;

class QrCode {
  QrCode._(this.version, this.size, this._modules);
  final int version;
  final int size;
  final List<List<bool>> _modules;

  bool dark(int x, int y) => x >= 0 && x < size && y >= 0 && y < size && _modules[y][x];

  factory QrCode.encode(String text, {QrEcc ecl = QrEcc.medium}) {
    final data = utf8.encode(text);
    var version = 1;
    late int capacityBits;
    for (; ; version++) {
      if (version > 40) throw ArgumentError('too long for a QR code');
      capacityBits = _dataCodewords(version, ecl) * 8;
      final countBits = version < 10 ? 8 : 16;
      if (4 + countBits + data.length * 8 <= capacityBits) break;
    }
    final bits = <bool>[];
    void put(int value, int len) {
      for (var i = len - 1; i >= 0; i--) {
        bits.add(_bit(value, i));
      }
    }

    put(0x4, 4);
    put(data.length, version < 10 ? 8 : 16);
    for (final b in data) {
      put(b, 8);
    }
    put(0, math.min(4, capacityBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) {
      put(pad, 8);
    }
    final codewords = List<int>.filled(bits.length ~/ 8, 0);
    for (var i = 0; i < bits.length; i++) {
      if (bits[i]) codewords[i >> 3] |= 1 << (7 - (i & 7));
    }
    return _Builder(version, ecl).build(codewords);
  }
}

class _Builder {
  _Builder(this.version, this.ecl) : size = version * 4 + 17 {
    modules = List.generate(size, (_) => List.filled(size, false));
    isFunction = List.generate(size, (_) => List.filled(size, false));
  }
  final int version;
  final QrEcc ecl;
  final int size;
  late List<List<bool>> modules;
  late List<List<bool>> isFunction;

  QrCode build(List<int> data) {
    _drawFunctionPatterns();
    _drawCodewords(_addEccAndInterleave(data));
    var best = 0;
    var minPenalty = 1 << 30;
    for (var m = 0; m < 8; m++) {
      _applyMask(m);
      _drawFormatBits(m);
      final p = _penalty();
      if (p < minPenalty) {
        best = m;
        minPenalty = p;
      }
      _applyMask(m);
    }
    _applyMask(best);
    _drawFormatBits(best);
    return QrCode._(version, size, modules);
  }

  void _set(int x, int y, bool dark) {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  }

  void _drawFunctionPatterns() {
    for (var i = 0; i < size; i++) {
      _set(6, i, i % 2 == 0);
      _set(i, 6, i % 2 == 0);
    }
    _finder(3, 3);
    _finder(size - 4, 3);
    _finder(3, size - 4);
    final align = _alignmentPositions();
    final n = align.length;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (!(i == 0 && j == 0 || i == 0 && j == n - 1 || i == n - 1 && j == 0)) _alignment(align[i], align[j]);
      }
    }
    _drawFormatBits(0);
    _drawVersion();
  }

  void _drawFormatBits(int mask) {
    final data = ecl.formatBits << 3 | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    }
    final bits = (data << 10 | rem) ^ 0x5412;
    for (var i = 0; i <= 5; i++) {
      _set(8, i, _bit(bits, i));
    }
    _set(8, 7, _bit(bits, 6));
    _set(8, 8, _bit(bits, 7));
    _set(7, 8, _bit(bits, 8));
    for (var i = 9; i < 15; i++) {
      _set(14 - i, 8, _bit(bits, i));
    }
    for (var i = 0; i < 8; i++) {
      _set(size - 1 - i, 8, _bit(bits, i));
    }
    for (var i = 8; i < 15; i++) {
      _set(8, size - 15 + i, _bit(bits, i));
    }
    _set(8, size - 8, true);
  }

  void _drawVersion() {
    if (version < 7) return;
    var rem = version;
    for (var i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
    }
    final bits = version << 12 | rem;
    for (var i = 0; i < 18; i++) {
      final b = _bit(bits, i);
      final a = size - 11 + i % 3;
      final c = i ~/ 3;
      _set(a, c, b);
      _set(c, a, b);
    }
  }

  void _finder(int x, int y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        final dist = math.max(dx.abs(), dy.abs());
        final xx = x + dx;
        final yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) _set(xx, yy, dist != 2 && dist != 4);
      }
    }
  }

  void _alignment(int x, int y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        _set(x + dx, y + dy, math.max(dx.abs(), dy.abs()) != 1);
      }
    }
  }

  List<int> _alignmentPositions() {
    if (version == 1) return const [];
    final numAlign = version ~/ 7 + 2;
    final step = version == 32 ? 26 : ((version * 4 + 4) / (numAlign * 2 - 2)).ceil() * 2;
    final result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) {
      result.insert(1, pos);
    }
    return result;
  }

  List<int> _addEccAndInterleave(List<int> data) {
    final numBlocks = _numBlocks[_row(ecl)][version];
    final blockEccLen = _eccPerBlock[_row(ecl)][version];
    final rawCodewords = _rawModules(version) ~/ 8;
    final numShortBlocks = numBlocks - rawCodewords % numBlocks;
    final shortBlockLen = rawCodewords ~/ numBlocks;
    final blocks = <List<int>>[];
    final divisor = _rsDivisor(blockEccLen);
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      final dat = data.sublist(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      final ecc = _rsRemainder(dat, divisor);
      final block = [...dat];
      if (i < numShortBlocks) block.add(0);
      blocks.add([...block, ...ecc]);
    }
    final result = <int>[];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i != shortBlockLen - blockEccLen || j >= numShortBlocks) result.add(blocks[j][i]);
      }
    }
    return result;
  }

  static int _mul(int x, int y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >> 7) * 0x11D);
      z ^= ((y >> i) & 1) * x;
    }
    return z;
  }

  static List<int> _rsDivisor(int degree) {
    final result = List<int>.filled(degree, 0);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = _mul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = _mul(root, 0x02);
    }
    return result;
  }

  static List<int> _rsRemainder(List<int> data, List<int> divisor) {
    final result = List<int>.filled(divisor.length, 0, growable: true);
    for (final b in data) {
      final factor = b ^ result.removeAt(0);
      result.add(0);
      for (var i = 0; i < divisor.length; i++) {
        result[i] ^= _mul(divisor[i], factor);
      }
    }
    return result;
  }

  void _drawCodewords(List<int> data) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          final x = right - j;
          final upward = ((right + 1) & 2) == 0;
          final y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = _bit(data[i >> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  void _applyMask(int mask) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        final invert = switch (mask) {
          0 => (x + y) % 2 == 0,
          1 => y % 2 == 0,
          2 => x % 3 == 0,
          3 => (x + y) % 3 == 0,
          4 => (x ~/ 3 + y ~/ 2) % 2 == 0,
          5 => x * y % 2 + x * y % 3 == 0,
          6 => (x * y % 2 + x * y % 3) % 2 == 0,
          _ => ((x + y) % 2 + x * y % 3) % 2 == 0,
        };
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  int _penalty() {
    const n1 = 3, n2 = 3, n3 = 40, n4 = 10;
    var result = 0;
    for (var pass = 0; pass < 2; pass++) {
      for (var a = 0; a < size; a++) {
        var runColor = false;
        var run = 0;
        final history = List<int>.filled(7, 0, growable: true);
        for (var b = 0; b < size; b++) {
          final m = pass == 0 ? modules[a][b] : modules[b][a];
          if (m == runColor) {
            run++;
            if (run == 5) {
              result += n1;
            } else if (run > 5) {
              result++;
            }
          } else {
            _addHistory(run, history);
            if (!runColor) result += _finderLike(history) * n3;
            runColor = m;
            run = 1;
          }
        }
        result += _terminate(runColor, run, history) * n3;
      }
    }
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        final c = modules[y][x];
        if (c == modules[y][x + 1] && c == modules[y + 1][x] && c == modules[y + 1][x + 1]) result += n2;
      }
    }
    var dark = 0;
    for (final row in modules) {
      for (final m in row) {
        if (m) dark++;
      }
    }
    final total = size * size;
    final k = ((dark * 20 - total * 10).abs() + total - 1) ~/ total - 1;
    result += k * n4;
    return result;
  }

  void _addHistory(int run, List<int> history) {
    if (history[0] == 0) run += size;
    history.removeLast();
    history.insert(0, run);
  }

  int _finderLike(List<int> h) {
    final n = h[1];
    final core = n > 0 && h[2] == n && h[3] == n * 3 && h[4] == n && h[5] == n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  }

  int _terminate(bool runColor, int run, List<int> history) {
    if (runColor) {
      _addHistory(run, history);
      run = 0;
    }
    run += size;
    _addHistory(run, history);
    return _finderLike(history);
  }
}

class QrImage extends StatelessWidget {
  const QrImage(this.code, {super.key, this.margin = 1});
  final QrCode code;
  final int margin;

  @override
  Widget build(BuildContext context) => AspectRatio(aspectRatio: 1, child: CustomPaint(painter: _QrPainter(code, margin)));
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.code, this.margin);
  final QrCode code;
  final int margin;

  @override
  void paint(Canvas canvas, Size size) {
    final n = code.size + margin * 2;
    final k = size.shortestSide / n;
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFFFFFFFF));
    final dark = Paint()
      ..color = const Color(0xFF000000)
      ..isAntiAlias = false;
    for (var y = 0; y < code.size; y++) {
      for (var x = 0; x < code.size; x++) {
        if (code.dark(x, y)) canvas.drawRect(Rect.fromLTWH((x + margin) * k, (y + margin) * k, k + .5, k + .5), dark);
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.code != code || old.margin != margin;
}
