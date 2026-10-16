// Positions are whole pixels.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'level.dart';
import 'particles.dart';
import 'pass.dart';

final _random = math.Random();

class Flap {
  const Flap.glyphs(this.up, this.down) : pictures = null;
  const Flap.pictures(Picture a, Picture b) : pictures = (a, b), up = const [], down = const [];
  final List<String> up;
  final List<String> down;
  final (Picture, Picture)? pictures;

  Look frame(bool open, ui.Color color, {double dir = 1}) {
    final p = pictures;
    if (p == null) {
      final rows = open ? up : down;
      return Glyph(rows, color);
    }
    final f = open ? p.$1 : p.$2;
    return Picture(f.image, f.w, f.h, name: f.name, dir: dir, tint: color);
  }
}

class _Flutterer {
  _Flutterer(this.home, this.color) : x = home.x, y = home.y, heading = _random.nextDouble() * math.pi * 2, phase = _random.nextDouble() * 6;
  final Pt home;
  final ui.Color color;
  double x;
  double y;
  double heading;
  double restUntil = 0;
  final double phase;
  bool open = true;
  double px = 0;
  double py = 0;
}

class Flutterers {
  Flutterers({required List<Pt> homes, required List<ui.Color> colors, required this.frames, this.range = 24, this.speed = 14})
    : _all = [for (var i = 0; i < homes.length; i++) _Flutterer(homes[i], colors[i % colors.length])];
  final Flap frames;
  final double range;
  final double speed;
  final List<_Flutterer> _all;
  double _shown = 0;

  /// `shown` (0..1) fades them in and out.
  void update(double t, double dt, double shown) {
    _shown = shown;
    if (shown <= 0.05) return;
    for (final b in _all) {
      final resting = t < b.restUntil;
      if (!resting) {
        b.heading += (_random.nextDouble() - 0.5) * dt * 6;
        final dx = b.home.x - b.x;
        final dy = b.home.y - b.y;
        if (math.sqrt(dx * dx + dy * dy) > range) b.heading = math.atan2(dy, dx);
        b.x += math.cos(b.heading) * speed * dt;
        b.y += math.sin(b.heading) * speed * 0.65 * dt + math.sin(t * 9 + b.phase) * 4 * dt;
        if (_random.nextDouble() < dt * 0.15) b.restUntil = t + 1.5 + _random.nextDouble() * 2;
      }
      b.open = resting ? ((t + b.phase) * 1.5).floor() % 3 == 0 : ((t + b.phase) * 10).floor() % 2 == 0;
      b.px = b.x.roundToDouble();
      b.py = (b.y - (resting ? 0 : 4)).roundToDouble();
    }
  }

  void render(ui.Canvas canvas, RenderPass pass, NormalsOf normals) {
    if (_shown <= 0.05) return;
    for (final b in _all) {
      drawLook(canvas, frames.frame(b.open, b.color), b.px, b.py, alpha: math.min(1, _shown * 1.5), pass: pass, normals: normals);
    }
  }
}

class _Bird {
  _Bird(this.x, this.y, this.speed, this.shadowAlpha) : phase = _random.nextDouble() * 6;
  double x;
  final double y;
  final double speed;
  final double shadowAlpha;
  final double phase;
  bool open = true;
  double px = 0;
  double py = 0;
}

class Flocks {
  Flocks({required this.frames, required this.color, required this.shadow, required this.drop, required this.width, required this.heights});
  final Flap frames;
  final ui.Color color;

  final Picture shadow;
  final double drop;

  final double width;
  final (double, double) heights;
  final _birds = <_Bird>[];

  /// `shadowAlpha` (0..1) is how dark their shadows are.
  void launch(double shadowAlpha) {
    final leftward = _random.nextBool();
    final y = heights.$1 + _random.nextDouble() * (heights.$2 - heights.$1);
    final speed = 60 + _random.nextDouble() * 25;
    final n = 2 + _random.nextInt(3);
    for (var i = 0; i < n; i++) {
      final back = (i / 2).ceil() * 9.0;
      final side = (i.isOdd ? 1 : -1) * (i / 2).ceil() * 5.0;
      _birds.add(_Bird(leftward ? width + 10 + back : -10 - back, y + side, leftward ? -speed : speed, shadowAlpha));
    }
  }

  void update(double t, double dt) {
    _birds.removeWhere((b) {
      b.x += b.speed * dt;
      b.open = ((t + b.phase) * 7).floor() % 2 == 0;
      b.px = b.x.roundToDouble();
      b.py = (b.y + math.sin(t * 2 + b.phase)).roundToDouble();
      return b.x < -40 || b.x > width + 40;
    });
  }

  void render(ui.Canvas canvas, RenderPass pass, NormalsOf normals) {
    for (final b in _birds) {
      drawLook(canvas, shadow, (b.x + 10).roundToDouble(), (b.y + drop).roundToDouble(), alpha: b.shadowAlpha, pass: pass);
      drawLook(
        canvas,
        frames.frame(b.open, color, dir: b.speed < 0 ? -1 : 1),
        b.px,
        b.py,
        pass: pass,
        normals: normals,
      );
    }
  }
}

class _Blinker {
  _Blinker(this.home) : phase = _random.nextDouble() * 10, speed = 0.25 + _random.nextDouble() * 0.35, blink = 1.8 + _random.nextDouble() * 1.6;
  final Pt home;
  final double phase;
  final double speed;
  final double blink;
  double x = 0;
  double y = 0;
  double alpha = 0;
}

typedef PointLight = ({double x, double y, double z, double radius, ui.Color color, double intensity});

class Blinkers {
  Blinkers({required List<Pt> homes, required this.color, required this.halo, required this.light}) : _all = [for (final h in homes) _Blinker(h)];
  final ui.Color color;

  final Picture halo;
  final ({double z, double radius, ui.Color color, double intensity}) light;
  final List<_Blinker> _all;

  List<PointLight> update(double t, double shown) {
    final lights = <PointLight>[];
    for (final f in _all) {
      final x = f.home.x + math.sin(t * f.speed + f.phase) * 14 + math.sin(t * f.speed * 2.3 + f.phase * 1.7) * 5;
      final y = f.home.y + math.cos(t * f.speed * 0.8 + f.phase) * 8;
      // In whole steps: half on the way in and out.
      final into = ((t + f.phase) % f.blink) / f.blink;
      final lit = into < 0.08 || (into > 0.62 && into < 0.7) ? 0.5 : (into < 0.62 ? 1.0 : 0.0);
      f
        ..x = x
        ..y = y
        ..alpha = lit * shown;
      if (lit * shown > 0) lights.add((x: x, y: y, z: light.z, radius: light.radius, color: light.color, intensity: light.intensity * lit * shown));
    }
    return lights;
  }

  void render(ui.Canvas canvas, RenderPass pass) {
    if (pass != RenderPass.glows) return;
    for (final f in _all) {
      if (f.alpha <= 0) continue;
      final x = f.x.roundToDouble();
      final y = f.y.roundToDouble();
      drawLook(canvas, halo, x, y, alpha: f.alpha, pass: pass);
      canvas.drawRect(
        ui.Rect.fromLTWH(x, y, 1, 1),
        ui.Paint()
          ..color = color.withValues(alpha: f.alpha)
          ..blendMode = ui.BlendMode.plus,
      );
    }
  }
}
