// Small things that fly, fall, drift and fade, and rings that widen and fade (a port of @heybro/engine/pixi
// particles.ts), with what they look like: a pixel, a little picture of '#' rows (glyph), a picture from the atlas,
// or a picture painted point by point (light.ts glowTexture, shadowTexture). Positions round to whole pixels and
// fading goes in steps, so it stays pixel art. Each one goes on a layer: the lit world, what shines over it, or the
// marks over everything, and is drawn in that layer's pass (pass.dart).

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'pass.dart';

final _random = math.Random();

/// Where something small is drawn: in the lit world, over it (what shines), or over everything as painted.
enum Layer { lit, shine, marks }

/// The pass a layer is drawn in.
RenderPass passOf(Layer l) => switch (l) {
  Layer.lit => RenderPass.color,
  Layer.shine => RenderPass.glows,
  Layer.marks => RenderPass.marks,
};

/// A picture's normal maps (as painted, and mirrored) by its atlas name; null when it has none.
typedef NormalsOf = (ui.Image, ui.Image)? Function(String name);

// ── What a bit looks like ────────────────────────────────────────────────────

sealed class Look {
  const Look();
}

/// One square pixel, `size` pixels square, from its top left.
final class Dot extends Look {
  const Dot(this.color, [this.size = 1]);
  final ui.Color color;
  final double size;
}

/// A little picture in pixels, one row per string: '#' is painted, from its top left (particles.ts glyph).
final class Glyph extends Look {
  const Glyph(this.rows, this.color);
  final List<String> rows;
  final ui.Color color;
}

/// A picture `w` by `h` art pixels, its anchor (fractions of its size) where it is put. `name` is its atlas name (for
/// its normal map in the lit world), null for a painted one. `add`: added onto what is under it. `tint` multiplies it
/// (pictures drawn white take it). `dir` -1 draws it mirrored.
final class Picture extends Look {
  const Picture(this.image, this.w, this.h, {this.name, this.ax = 0.5, this.ay = 0.5, this.dir = 1, this.tint, this.add = false});
  final ui.Image image;
  final double w;
  final double h;
  final String? name;
  final double ax;
  final double ay;
  final double dir;
  final ui.Color? tint;
  final bool add;
}

/// Draws `look` at (`x`, `y`) in `pass`, `alpha` opaque, grown `scale` times about where it is put. In the normals
/// pass only atlas pictures draw (their normal map); everything else is lit as the ground behind it (light.ts).
void drawLook(ui.Canvas canvas, Look look, double x, double y, {double alpha = 1, double scale = 1, RenderPass pass = RenderPass.color, NormalsOf? normals}) {
  if (alpha <= 0) return;
  final normalsPass = pass == RenderPass.normals;
  switch (look) {
    case Dot(:final color, :final size):
      if (normalsPass) return;
      canvas.drawRect(ui.Rect.fromLTWH(x, y, size * scale, size * scale), ui.Paint()..color = color.withValues(alpha: color.a * alpha));
    case Glyph(:final rows, :final color):
      if (normalsPass) return;
      final paint = ui.Paint()..color = color.withValues(alpha: color.a * alpha);
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < rows[r].length; c++) {
          if (rows[r][c] == '#') canvas.drawRect(ui.Rect.fromLTWH(x + c * scale, y + r * scale, scale, scale), paint);
        }
      }
    case final Picture p:
      var image = p.image;
      if (normalsPass) {
        final n = p.name == null ? null : normals?.call(p.name!);
        if (n == null) return;
        image = p.dir < 0 ? n.$2 : n.$1;
      }
      canvas.save();
      canvas.translate(x, y);
      canvas.scale(p.dir * scale, scale);
      final paint = ui.Paint()
        ..filterQuality = ui.FilterQuality.none
        ..color = ui.Color.fromRGBO(255, 255, 255, alpha.clamp(0, 1));
      if (!normalsPass) {
        if (p.tint != null) paint.colorFilter = ui.ColorFilter.mode(p.tint!, ui.BlendMode.modulate);
        if (p.add) paint.blendMode = ui.BlendMode.plus;
      }
      canvas.drawImageRect(
        image,
        ui.Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
        ui.Rect.fromLTWH(-p.w * p.ax, -p.h * p.ay, p.w, p.h),
        paint,
      );
      canvas.restore();
  }
}

// ── Pictures painted point by point (light.ts painted) ───────────────────────

final _paintedCache = <String, ui.Image>{};

/// A pixel picture `w` by `h`, made point by point: `alpha(dx, dy)` with dx, dy from the middle in -1..1, in one colour.
ui.Image painted(String key, int w, int h, ui.Color color, double Function(double dx, double dy) alpha) => _paintedCache.putIfAbsent(key, () {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  final paint = ui.Paint()..isAntiAlias = false;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final a = (255 * alpha(((x + 0.5) / w) * 2 - 1, ((y + 0.5) / h) * 2 - 1).clamp(0.0, 1.0)).round();
      if (a == 0) continue;
      canvas.drawRect(ui.Rect.fromLTWH(x.toDouble(), y.toDouble(), 1, 1), paint..color = color.withAlpha(a));
    }
  }
  return recorder.endRecording().toImageSync(w, h);
});

/// A soft round glow, `radius` art pixels, centred: for what shines by itself (a lamp's glass, a lantern, a firefly,
/// a puff of smoke). `add` it for what shines.
Picture glow(int radius, ui.Color color, {double strength = 0.55, bool add = false}) => Picture(
  painted('glow:$radius:${color.toARGB32()}:$strength', radius * 2, radius * 2, color, (dx, dy) {
    final d = math.sqrt(dx * dx + dy * dy);
    return d < 1 ? strength * (1 - d) * (1 - d) : 0;
  }),
  radius * 2.0,
  radius * 2.0,
  add: add,
);

/// A shadow on the ground under something standing, `w` by `h`, centred: an ellipse in two hard steps, darker in the
/// middle (a soft edge would read as haze beside the feet, not as ground under them).
Picture groundShadow(int w, int h) => Picture(
  painted('shadow:$w:$h', w, h, const ui.Color(0xFF1F160C), (dx, dy) {
    final d = math.sqrt(dx * dx + dy * dy);
    return d < 0.6 ? 1 : (d < 1 ? 0.55 : 0);
  }),
  w.toDouble(),
  h.toDouble(),
);

// ── Particles ────────────────────────────────────────────────────────────────

/// Steps of fading: a quarter at a time; pixels a second the wind gives a drift of 1 at full strength.
const _steps = 4;
const _wind = 2.0;

sealed class _Item {
  _Item(this.layer, this.life);
  final Layer layer;
  final double life;
  double age = 0;
}

final class _Bit extends _Item {
  _Bit(super.layer, this.look, this.x, this.y, super.life, this.vx, this.vy, this.fall, this.drift, this.sway, this.grow, this.alpha)
    : px = x.roundToDouble(),
      py = y.roundToDouble(),
      phase = _random.nextDouble() * 6;
  final Look look;
  double x;
  double y;
  double vx;
  double vy;
  final double fall;
  final double drift;
  final double sway;
  final double grow;
  final double alpha;
  final double phase;

  /// As drawn: where (whole pixels), how big, how opaque. Until its first step it shows where it was put, as it is.
  double px;
  double py;
  double scale = 1;
  double opacity = 1;
}

final class _Ring extends _Item {
  _Ring(super.layer, this.x, this.y, this.from, this.to, this.squash, this.color, super.life);
  final double x;
  final double y;
  final double from;
  final double to;
  final double squash;
  final ui.Color color;

  /// Its radius and alpha as drawn; null until its first step.
  double? radius;
  double alpha = 0;
}

class Particles {
  Particles({required this.density});

  /// The pictures' pixels per art pixel: a ring's line is one of them wide (pixelLine).
  final double density;
  final _items = <_Item>[];

  /// How many are moving now.
  int get count => _items.length;

  /// Puts `look` on `layer` at (`x`, `y`) and moves it on until its `life` (seconds) is over: `fall` pulls it down
  /// (pixels a second squared), the wind carries it by `drift`, it swings side to side by `sway`, grows by `grow` a
  /// second, starts `alpha` opaque.
  void add(
    Layer layer,
    Look look, {
    required double x,
    required double y,
    required double life,
    double vx = 0,
    double vy = 0,
    double fall = 0,
    double drift = 0,
    double sway = 0,
    double grow = 0,
    double alpha = 1,
  }) => _items.add(_Bit(layer, look, x, y, life, vx, vy, fall, drift, sway, grow, alpha));

  /// A ring on `layer` widening from `from` to `to`, `squash` its height over its width (flat on water, 1 in the air).
  void ring(
    Layer layer, {
    required double x,
    required double y,
    required double from,
    required double to,
    required double squash,
    required ui.Color color,
    required double life,
  }) => _items.add(_Ring(layer, x, y, from, to, squash, color, life));

  /// Moves everything on by `dt` seconds; `wind` (0..1) carries what drifts.
  void step(double dt, [double wind = 0]) {
    _items.removeWhere((i) {
      i.age += dt;
      if (i.age >= i.life) return true;
      switch (i) {
        case final _Bit b:
          b.vy += b.fall * dt;
          b.x += (b.vx + wind * b.drift * _wind) * dt;
          b.y += b.vy * dt;
          final swing = b.sway != 0 ? math.sin(b.age * 3 + b.phase) * b.sway : 0;
          b.px = (b.x + swing).roundToDouble();
          b.py = b.y.roundToDouble();
          if (b.grow != 0) b.scale = 1 + b.grow * b.age;
          b.opacity = b.alpha * ((1 - b.age / b.life) * _steps).ceil() / _steps;
        case final _Ring r:
          final k = r.age / r.life;
          r.radius = (r.from + (r.to - r.from) * k).roundToDouble();
          r.alpha = ((1 - k) * 3).ceil() / 3;
      }
      return false;
    });
  }

  /// Draws what is on `layer`, in the order it was added.
  void render(ui.Canvas canvas, Layer layer, RenderPass pass, {NormalsOf? normals}) {
    final mine = passOf(layer) == pass || (layer == Layer.lit && pass == RenderPass.normals);
    if (!mine) return;
    for (final i in _items) {
      if (i.layer != layer) continue;
      switch (i) {
        case final _Bit b:
          drawLook(canvas, b.look, b.px, b.py, alpha: b.opacity, scale: b.scale, pass: pass, normals: normals);
        case final _Ring r:
          final radius = r.radius;
          if (radius == null || pass == RenderPass.normals) continue;
          canvas.drawOval(
            ui.Rect.fromCenter(
              center: ui.Offset(r.x.roundToDouble(), r.y.roundToDouble()),
              width: radius * 2,
              height: math.max(1, (radius * r.squash).roundToDouble()) * 2,
            ),
            ui.Paint()
              ..style = ui.PaintingStyle.stroke
              ..strokeWidth = 1 / density
              ..isAntiAlias = false
              ..color = r.color.withValues(alpha: r.alpha),
          );
      }
    }
  }
}
