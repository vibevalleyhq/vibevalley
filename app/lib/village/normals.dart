// Normals are in screen terms: x right, y down the screen, z out of it. Stored as RGBA, each axis from -1..1 to 0..255 (128 is 0), the picture's own alpha
// kept.

import 'dart:math' as math;
import 'dart:typed_data';

class NormalOptions {
  const NormalOptions({required this.bevel, required this.relief, required this.strength});

  /// 0: no rounding.
  final double bevel;

  final double relief;

  final double strength;
}

const spriteNormals = NormalOptions(bevel: 3, relief: 0.35, strength: 1);

const lowNormals = NormalOptions(bevel: 1.5, relief: 0.3, strength: 0.8);

const groundNormals = NormalOptions(bevel: 0, relief: 0.6, strength: 0.6);

const _solid = 128;

Uint8List normalsOf(Uint8List rgba, int w, int h, NormalOptions o) {
  final n = w * h;
  bool solid(int x, int y) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] >= _solid;

  // The picture's edge counts as outside: two chamfer passes.
  final far = Float32List(n);
  final cap = math.max(o.bevel, 0.0);
  if (cap > 0) {
    for (var i = 0; i < n; i++) {
      far[i] = solid(i % w, i ~/ w) ? double.infinity : 0;
    }
    double at(int x, int y) => x >= 0 && y >= 0 && x < w && y < h ? far[y * w + x] : 0;
    void relax(int x, int y, int dx) {
      final i = y * w + x;
      final here = far[i];
      if (here == 0) return;
      final sy = dx.sign;
      far[i] = [here, at(x - dx, y) + 1, at(x, y - sy) + 1, at(x - dx, y - sy) + math.sqrt2, at(x + dx, y - sy) + math.sqrt2].reduce(math.min);
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        relax(x, y, 1);
      }
    }
    for (var y = h - 1; y >= 0; y--) {
      for (var x = w - 1; x >= 0; x--) {
        relax(x, y, -1);
      }
    }
  }

  final height = Float32List(n);
  for (var i = 0; i < n; i++) {
    if (!solid(i % w, i ~/ w)) continue;
    final pillow = cap > 0 ? math.sqrt(math.min(far[i], cap) / cap) : 0.0;
    height[i] = pillow + o.relief * (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  }
  // Past the picture's edge the height goes on as at the edge: a map has no rim.
  double hAt(int x, int y) => height[y.clamp(0, h - 1) * w + x.clamp(0, w - 1)];

  final out = Uint8List(n * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x;
      var nx = 0.0;
      var ny = 0.0;
      if (solid(x, y)) {
        final gx = hAt(x + 1, y - 1) + 2 * hAt(x + 1, y) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x - 1, y) - hAt(x - 1, y + 1);
        final gy = hAt(x - 1, y + 1) + 2 * hAt(x, y + 1) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x, y - 1) - hAt(x + 1, y - 1);
        nx = (-gx / 4) * o.strength;
        ny = (-gy / 4) * o.strength;
      }
      final len = math.sqrt(nx * nx + ny * ny + 1);
      out[i * 4] = (((nx / len) * 0.5 + 0.5) * 255).round();
      out[i * 4 + 1] = (((ny / len) * 0.5 + 0.5) * 255).round();
      out[i * 4 + 2] = (((1 / len) * 0.5 + 0.5) * 255).round();
      out[i * 4 + 3] = rgba[i * 4 + 3];
    }
  }
  return out;
}

/// The sprite's flip mirrors the pixels; each one now faces the other way.
Uint8List mirrorNormals(Uint8List normals) {
  final out = Uint8List.fromList(normals);
  for (var i = 0; i < out.length; i += 4) {
    out[i] = 255 - normals[i];
  }
  return out;
}
