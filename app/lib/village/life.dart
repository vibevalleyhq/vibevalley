// None of it is the farm's state: it is drawn from it, every frame.

import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flame/components.dart';

import '../audio/sfx.dart';
import 'critters.dart';
import 'level.dart';
import 'particles.dart';
import 'pass.dart';
import 'world.dart';

final _random = math.Random();
double _rand(double lo, double hi) => lo + _random.nextDouble() * (hi - lo);
T _pick<T>(List<T> xs) => xs[_random.nextInt(xs.length)];
Pt _inside(Box b) => Pt(_rand(b.x0, b.x1), _rand(b.y0, b.y1));

/// 0.1 (calm) to 1 (a gust), changing slowly.
double gust(double t) => 0.55 + 0.45 * math.sin(t * 0.21) * math.sin(t * 0.067 + 1);

/// Each wait is 70–130% of `seconds`; the first call only starts the count, at a random point in the first wait.
class Cadence {
  Cadence([math.Random? random]) : _random = random ?? math.Random();
  final math.Random _random;
  final _next = <String, double>{};
  bool due(String key, double seconds, double now) {
    final at = _next[key];
    if (at == null) {
      _next[key] = now + _random.nextDouble() * seconds;
      return false;
    }
    if (now < at) return false;
    _next[key] = now + seconds * (0.7 + _random.nextDouble() * 0.6);
    return true;
  }
}

enum Material { water, leaves, soil, stone, other }

Material materialOf(int r, int g, int b) {
  final mx = math.max(r, math.max(g, b));
  final mn = math.min(r, math.min(g, b));
  final saturation = mx == 0 ? 0.0 : (mx - mn) / mx;
  final value = mx / 255;
  if (saturation < 0.18) return Material.stone;
  final d = (mx - mn).toDouble();
  final h = mx == r ? ((g - b) / d) % 6 : (mx == g ? (b - r) / d + 2 : (r - g) / d + 4);
  final hue = (h * 60 + 360) % 360;
  if (hue >= 165 && hue < 250) return Material.water;
  if (hue >= 45 && hue < 165) return Material.leaves;
  if (hue >= 20 && hue < 45 && saturation > 0.45 && value > 0.6) return Material.soil;
  return Material.other;
}

/// A teal roof is not the pond.
sealed class Ground {
  const Ground();
}

final class Painted extends Ground {
  const Painted(this.material);
  final Material material;
}

final class Pond extends Ground {
  const Pond();
}

const _heart = ['.#.#.', '#####', '.###.', '..#..'];
const _zed = ['####', '..#.', '.#..', '####'];
const _sparkle = ['.#.', '###', '.#.'];
const _butterfly = Flap.glyphs(['#.#', '.#.'], ['.#.', '.#.']);
const _bird = Flap.glyphs(['#...#', '.###.'], ['.###.', '#...#']);

const _meadows = <Box>[(x0: 12, y0: 110, x1: 90, y1: 215), (x0: 300, y0: 140, x1: 380, y1: 200), (x0: 90, y0: 92, x1: 300, y1: 110)];
const _yard = (x0: 40.0, y0: 100.0, x1: 330.0, y1: 236.0);

class LifeFrame {
  const LifeFrame({
    required this.t,
    required this.dt,
    required this.night,
    required this.walkers,
    required this.busy,
    required this.ripe,
    required this.dogAsleep,
  });
  final double t;
  final double dt;

  /// 0 by day, 1 at night.
  final double night;

  final List<Pt> walkers;

  final Map<String, int> busy;

  final List<Box> ripe;
  final bool dogAsleep;
}

class VillageLife extends Component {
  VillageLife({required this.village, required this.picture, required this.normals, required this.map, required this.mapWidth, required this.density})
    : bits = Particles(density: density);

  final VillageWorld village;

  final Picture? Function(String name) picture;
  final NormalsOf normals;

  final ByteData map;
  final int mapWidth;
  final double density;

  final Particles bits;
  final _cadence = Cadence();
  late final _puff = glow(4, const ui.Color(0xFFEBE6DC), strength: 0.9);
  late final _dustPuff = glow(3, const ui.Color(0xFFF6E7C6), strength: 0.8);

  /// Butterflies are drawn white and take their colour; birds keep theirs.
  Flap _flap(String name, Flap glyphs) {
    final a = picture('$name-1');
    final b = picture('$name-2');
    return a != null && b != null ? Flap.pictures(a, b) : glyphs;
  }

  late final _birdFrames = _flap('critter-bird', _bird);
  late final _butterflies = Flutterers(
    homes: [for (var i = 0; i < 5; i++) _inside(_meadows[i % _meadows.length])],
    colors: const [ui.Color(0xFFF6F1E4), ui.Color(0xFFF5D76E), ui.Color(0xFFF2A6B8)],
    frames: _flap('critter-butterfly', _butterfly),
  );
  late final _birds = Flocks(
    frames: _birdFrames,
    color: _birdFrames.pictures == null ? const ui.Color(0xFF33302C) : const ui.Color(0xFFFFFFFF),
    shadow: groundShadow(7, 3),
    drop: 70,
    width: village.width,
    heights: (18, 120),
  );
  late final _fireflies = Blinkers(
    homes: [for (var i = 0; i < 12; i++) _inside(_yard)],
    color: const ui.Color(0xFFEAFF9E),
    halo: glow(6, const ui.Color(0xFFC6FF70), strength: 0.5, add: true),
    light: (z: 4, radius: 14, color: const ui.Color(0xFFC6FF70), intensity: 0.85),
  );
  double _flash = 0;

  Ground? groundAt(double x, double y) {
    final px = (x * density).floor();
    final py = (y * density).floor();
    if (px < 0 || py < 0 || px >= mapWidth) return null;
    final i = (py * mapWidth + px) * 4;
    if (i + 2 >= map.lengthInBytes) return null;
    final m = materialOf(map.getUint8(i), map.getUint8(i + 1), map.getUint8(i + 2));
    return m == Material.water && village.fx['pond']!.any((b) => inBox(Pt(x, y), b)) ? const Pond() : Painted(m);
  }

  Pt? _somewhere(Box box, bool Function(Ground) want) {
    for (var i = 0; i < 8; i++) {
      final p = _inside(box);
      final g = groundAt(p.x, p.y);
      if (g != null && want(g)) return p;
    }
    return null;
  }

  static bool _isPond(Ground g) => g is Pond;
  static bool _isLeaves(Ground g) => g is Painted && g.material == Material.leaves;

  /// dir: 1 right, -1 left.
  Look _critter(String name, Look fallback, {double dir = 1}) {
    final p = picture(name);
    return p == null ? fallback : Picture(p.image, p.w, p.h, name: p.name, dir: dir);
  }

  bool _workshopChimney(Box b) => inBox(Pt((b.x0 + b.x1) / 2, b.y0), village.spotBoxes[YardPlace.runtimes]!);

  void _zzz(double x, double y) => bits.add(Layer.marks, const Glyph(_zed, ui.Color(0xFFF4EFE0)), x: x, y: y, vx: 3, vy: -5, sway: 1.5, alpha: 0.85, life: 2.2);

  void heart(double x, double y) => bits.add(Layer.marks, const Glyph(_heart, ui.Color(0xFFFF7A9A)), x: x - 2, y: y - 4, vy: -12, sway: 2, life: 1.1);

  void poke(double x, double y) {
    bits.ring(Layer.marks, x: x, y: y, from: 1, to: 5, squash: 0.5, color: const ui.Color(0xFFFFF6D8), life: 0.35);
    switch (groundAt(x, y)) {
      case Pond():
        for (var i = 0; i < 8; i++) {
          bits.add(Layer.lit, const Dot(ui.Color(0xFFCFEFF2)), x: x, y: y, vx: _rand(-25, 25), vy: _rand(-55, -25), fall: 170, life: _rand(0.4, 0.6));
        }
        bits
          ..ring(Layer.lit, x: x, y: y, from: 1, to: 7, squash: 0.45, color: const ui.Color(0xFFBFE3E6), life: 0.9)
          ..ring(Layer.lit, x: x, y: y, from: 1, to: 4, squash: 0.45, color: const ui.Color(0xFFBFE3E6), life: 0.6);
        Sfx.play('splash');
      case Painted(material: Material.leaves):
        for (var i = 0; i < 7; i++) {
          bits.add(
            Layer.lit,
            Dot(_pick(const [ui.Color(0xFF9DBB4E), ui.Color(0xFF7D9A3A), ui.Color(0xFFC8D36A)])),
            x: x + _rand(-2, 2),
            y: y,
            vx: _rand(-22, 22),
            vy: _rand(-42, -16),
            fall: 110,
            life: _rand(0.5, 0.75),
          );
        }
        for (var i = 0; i < 2; i++) {
          bits.add(
            Layer.lit,
            Dot(_pick(const [ui.Color(0xFF8AA43A), ui.Color(0xFFC9A23A)]), 2),
            x: x,
            y: y - 2,
            vx: _rand(-6, 6),
            vy: _rand(-10, -4),
            fall: 14,
            sway: 5,
            drift: 0.6,
            life: _rand(1.2, 1.8),
          );
        }
        Sfx.play('rustle');
      case Painted(material: Material.soil):
        for (var i = 0; i < 10; i++) {
          bits.add(
            Layer.lit,
            Dot(_pick(const [ui.Color(0xFFF6E3BD), ui.Color(0xFFE9CFA0), ui.Color(0xFFFFF2D6)]), _pick(const [1.0, 1.0, 2.0])),
            x: x + _rand(-2, 2),
            y: y,
            vx: _rand(-28, 28),
            vy: _rand(-24, -6),
            fall: 40,
            life: _rand(0.35, 0.6),
          );
        }
        for (var i = 0; i < 2; i++) {
          bits.add(Layer.lit, _dustPuff, x: x + _rand(-3, 3), y: y - 1, vx: _rand(-8, 8), vy: -4, grow: 1.2, alpha: 0.8, life: 0.5);
        }
        Sfx.play('thud');
      case Painted():
        for (var i = 0; i < 4; i++) {
          bits.add(Layer.shine, const Dot(ui.Color(0xFFFFF6D8)), x: x, y: y, vx: _rand(-20, 20), vy: _rand(-28, -8), fall: 60, life: 0.3);
        }
        Sfx.play('tap');
      case null:
        return;
    }
  }

  List<PointLight> task(LifeFrame f) {
    final t = f.t;
    final dt = f.dt;
    final night = f.night;
    final day = math.max(0.0, 1 - night * 1.6);
    final wind = gust(t);
    final lights = <PointLight>[];
    int busy(String place) => f.busy[place] ?? 0;

    final chimneys = village.fx['chimney']!;
    for (var i = 0; i < chimneys.length; i++) {
      final b = chimneys[i];
      final thick = _workshopChimney(b) && busy('workshop') > 0;
      if (_cadence.due('smoke:$i', thick ? 0.22 : 0.45, t)) {
        bits.add(
          Layer.lit,
          _puff,
          x: (b.x0 + b.x1) / 2 + _rand(-1, 1),
          y: b.y0,
          vy: _rand(-7, -5),
          drift: 6,
          sway: 1,
          grow: 0.7,
          alpha: night > 0.5 ? 0.5 : 0.8,
          life: _rand(2.6, 3.4),
        );
      }
    }

    if (_cadence.due('leaf', 2.6 / (0.4 + wind), t)) {
      final from = _somewhere((x0: 0, y0: 26, x1: village.width, y1: 70), _isLeaves) ?? _somewhere((x0: 0, y0: 100, x1: 70, y1: 220), _isLeaves);
      if (from != null) {
        bits.add(
          Layer.lit,
          _critter(
            _pick(const ['critter-leaf-1', 'critter-leaf-2']),
            Dot(_pick(const [ui.Color(0xFF8AA43A), ui.Color(0xFF6F8F2F), ui.Color(0xFFC9A23A)]), _pick(const [1.0, 2.0])),
          ),
          x: from.x,
          y: from.y,
          vy: _rand(6, 10),
          drift: 10,
          sway: 6,
          life: _rand(3.5, 5.5),
        );
      }
    }

    for (final pond in village.fx['pond']!) {
      final ripple = _cadence.due('ripple', 1.2, t) ? _somewhere(pond, _isPond) : null;
      if (ripple != null) {
        bits.ring(Layer.lit, x: ripple.x, y: ripple.y, from: 1, to: _rand(4, 7), squash: 0.45, color: const ui.Color(0xFFBFE3E6), life: 1.3);
      }
      final glint = day > 0.3 && _cadence.due('glint', 0.12, t) ? _somewhere(pond, _isPond) : null;
      if (glint != null) bits.add(Layer.shine, const Dot(ui.Color(0xFFFFFBE8)), x: glint.x, y: glint.y, alpha: day, life: 0.3);
      final fish = _cadence.due('fish', 18, t) ? _somewhere(pond, _isPond) : null;
      if (fish != null) {
        final dir = _random.nextBool() ? -1.0 : 1.0;
        bits
          ..add(
            Layer.lit,
            _critter('critter-fish-1', const Dot(ui.Color(0xFFD9874A), 2), dir: dir),
            x: fish.x,
            y: fish.y,
            vx: _rand(14, 22) * dir,
            vy: -30,
            fall: 100,
            life: 0.6,
          )
          ..ring(Layer.lit, x: fish.x, y: fish.y, from: 1, to: 5, squash: 0.45, color: const ui.Color(0xFFBFE3E6), life: 0.8);
      }
    }

    if (f.dogAsleep && _cadence.due('zzz', 1.8, t)) _zzz(village.dog.x + 5, village.dog.y - 13);

    if (_cadence.due('dust', 0.16, t)) {
      for (final w in f.walkers) {
        final at = groundAt(w.x, w.y);
        if (at is Painted && at.material == Material.soil) {
          bits.add(
            Layer.lit,
            Dot(_pick(const [ui.Color(0xFFF6E3BD), ui.Color(0xFFE9CFA0)]), _pick(const [1.0, 2.0])),
            x: w.x + _rand(-3, 3),
            y: w.y - 1,
            vx: _rand(-6, 6),
            vy: _rand(-6, -2),
            fall: 10,
            alpha: 0.85,
            life: _rand(0.35, 0.55),
          );
        } else if (at is Painted && at.material == Material.leaves && _random.nextDouble() < 0.35) {
          bits.add(Layer.lit, const Dot(ui.Color(0xFF9DBB4E)), x: w.x + _rand(-3, 3), y: w.y - 1, vy: -6, fall: 30, life: 0.35);
        }
      }
    }

    final anvil = village.fx['anvil']!.firstOrNull;
    if (anvil != null && busy('workshop') > 0 && _cadence.due('anvil', 0.3, t)) {
      final cx = (anvil.x0 + anvil.x1) / 2;
      for (var i = 0; i < 4; i++) {
        bits.add(
          Layer.shine,
          Dot(_pick(const [ui.Color(0xFFFFD27A), ui.Color(0xFFFFB347), ui.Color(0xFFFFF1C2)])),
          x: cx + _rand(-2, 2),
          y: anvil.y0,
          vx: _rand(-32, 32),
          vy: _rand(-48, -20),
          fall: 130,
          life: _rand(0.3, 0.6),
        );
      }
      _flash = 0.16;
    }
    if (anvil != null && _flash > 0) {
      _flash -= dt;
      lights.add((x: (anvil.x0 + anvil.x1) / 2, y: anvil.y0, z: 8, radius: 28, color: const ui.Color(0xFFFFB347), intensity: 1.1));
    }

    final library = village.places['library'];
    if (library != null && busy('library') > 0 && _cadence.due('pages', 0.45, t)) {
      bits.add(
        Layer.lit,
        const Dot(ui.Color(0xFFF3EFE3), 2),
        x: library.at.x + _rand(-8, 8),
        y: library.at.y - 18,
        vy: _rand(-8, -4),
        sway: 4,
        drift: 0.4,
        life: 1.6,
      );
    }

    final mast = village.fx['mast']!.firstOrNull;
    if (mast != null) {
      final top = Pt((mast.x0 + mast.x1) / 2, mast.y0);
      if (busy('mast') > 0 && _cadence.due('waves', 0.6, t)) {
        bits.ring(Layer.shine, x: top.x, y: top.y, from: 2, to: 14, squash: 1, color: const ui.Color(0xFF8FE3FF), life: 0.9);
      }
      if (night > 0.3 && t % 1.6 < 0.9) {
        if (_cadence.due('beacon', 0.05, t)) bits.add(Layer.shine, const Dot(ui.Color(0xFFFF5A4A)), x: top.x, y: top.y - 1, life: 0.06);
        lights.add((x: top.x, y: top.y, z: 6, radius: 14, color: const ui.Color(0xFFFF5A4A), intensity: 0.7 * night));
      }
    }

    final bench = village.places['bench'];
    if (bench != null && busy('bench') > 0 && _cadence.due('bench', 1.6, t)) _zzz(bench.at.x + 2, bench.at.y - 26);

    for (var i = 0; i < f.ripe.length; i++) {
      final b = f.ripe[i];
      if (_cadence.due('ripe:$i', 0.35, t)) {
        bits.add(Layer.shine, const Glyph(_sparkle, ui.Color(0xFFFFE9A0)), x: _rand(b.x0 + 2, b.x1 - 4), y: _rand(b.y0 - 6, b.y0 + 6), vy: -4, life: 0.6);
      }
    }

    _butterflies.update(t, dt, day);
    if (day > 0.5 && _cadence.due('birds', 28, t)) _birds.launch(0.3 * day);
    _birds.update(t, dt);
    lights.addAll(_fireflies.update(t, night > 0.4 ? (night - 0.4) / 0.6 : 0));

    bits.task(dt, wind);
    return lights;
  }

  @override
  void render(ui.Canvas canvas) {
    final pass = renderPass;
    switch (pass) {
      case RenderPass.color || RenderPass.normals:
        // In the lit world, in the order they came: the butterflies, then what flies and falls, then the birds.
        _butterflies.render(canvas, pass, normals);
        bits.render(canvas, Layer.lit, pass, normals: normals);
        _birds.render(canvas, pass, normals);
      case RenderPass.glows:
        // The fireflies were there first; sparks, glints and twinkles come over them.
        _fireflies.render(canvas, pass);
        bits.render(canvas, Layer.shine, pass);
      case RenderPass.marks:
        bits.render(canvas, Layer.marks, pass);
      case RenderPass.near:
        return;
    }
  }
}
