// Particles move in whole pixels and fade in steps.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flame/components.dart';

import '../game/tools.dart' show BedFxKind;

import 'critters.dart' show PointLight;
import 'particles.dart';
import 'pass.dart';
import 'world.dart';

final _random = math.Random();
double _rand(double lo, double hi) => lo + _random.nextDouble() * (hi - lo);

class _Flash {
  _Flash(this.x, this.y, this.radius, this.color, this.strength, this.life);
  final double x;
  final double y;
  final double radius;
  final ui.Color color;
  final double strength;
  final double life;
  double age = 0;
}

class PlotFx extends Component {
  PlotFx({required this.village, required this.picture, required this.normals, required double density}) : _bits = Particles(density: density);

  final VillageWorld village;

  final Picture? Function(String name, {double ax, double ay}) picture;
  final NormalsOf normals;
  final Particles _bits;
  final _flashes = <_Flash>[];
  double _clock = 0;

  /// It dips a pixel for a moment.
  final pressedAt = <int, double>{};

  ({double x, double y}) _centre(int bed) {
    final at = village.plotAt(bed);
    return (x: at.x, y: at.y - plotH / 2);
  }

  void _add(Look look, {required double x, required double y, required double vx, required double vy, required double fall, required double life}) =>
      _bits.add(Layer.lit, look, x: x, y: y, vx: vx, vy: vy, fall: fall, life: life);

  void burst(BedFxKind kind, int bed) {
    final c = _centre(bed);
    pressedAt[bed] = _clock;
    switch (kind) {
      case BedFxKind.water:
        for (var i = 0; i < 14; i++) {
          _add(
            Dot(i % 3 != 0 ? const ui.Color(0xFF6FB3E0) : const ui.Color(0xFFC8E6F7)),
            x: c.x + _rand(-12, 12),
            y: c.y - _rand(14, 26),
            vx: 0,
            vy: _rand(10, 30),
            fall: 160,
            life: _rand(0.35, 0.6),
          );
        }
      case BedFxKind.spray:
        for (var i = 0; i < 12; i++) {
          _add(const Dot(ui.Color(0xFFF4F1E6), 2), x: c.x + _rand(-4, 4), y: c.y - 4, vx: _rand(-24, 24), vy: _rand(-26, -6), fall: 0, life: _rand(0.5, 0.9));
        }
      case BedFxKind.shovel:
        for (var i = 0; i < 12; i++) {
          _add(
            Dot(i.isOdd ? const ui.Color(0xFF8A6A45) : const ui.Color(0xFF5D4429), 2),
            x: c.x + _rand(-8, 8),
            y: c.y,
            vx: _rand(-30, 30),
            vy: _rand(-50, -20),
            fall: 140,
            life: _rand(0.4, 0.7),
          );
        }
      case BedFxKind.harvest:
        final icon = picture('icon-harvest', ax: 0.5, ay: 1);
        if (icon != null) _add(icon, x: c.x, y: c.y, vx: 0, vy: -38, fall: 30, life: 1.1);
        _flashes.add(_Flash(c.x, c.y - 6, 46, const ui.Color(0xFFFFD36A), 1.3, 0.8));
        for (var i = 0; i < 10; i++) {
          _add(const Dot(ui.Color(0xFFF2C14E)), x: c.x + _rand(-6, 6), y: c.y - 4, vx: _rand(-30, 30), vy: _rand(-60, -30), fall: 150, life: _rand(0.5, 0.8));
        }
      case BedFxKind.note:
        return;
    }
  }

  void coins(int bed, double n) {
    final c = _centre(bed);
    _flashes.add(_Flash(c.x, c.y - 8, 30, const ui.Color(0xFFFFE08A), 0.9, 0.6));
    final coin = picture('icon-coin');
    if (coin == null) return;
    final half = Picture(coin.image, coin.w / 2, coin.h / 2, name: coin.name);
    for (var i = 0; i < (n / 5).round().clamp(2, 6); i++) {
      _add(half, x: c.x + _rand(-6, 6), y: c.y - 6, vx: _rand(-18, 18), vy: _rand(-70, -50), fall: 140, life: 0.9);
    }
  }

  void task(double dt) {
    _clock += dt;
    _flashes.removeWhere((f) => (f.age += dt) >= f.life);
    _bits.task(dt);
  }

  double get clock => _clock;

  /// Bright at once, then gone in a few steps.
  List<PointLight> get lights => [
    for (final f in _flashes) (x: f.x, y: f.y, z: 12, radius: f.radius, color: f.color, intensity: f.strength * (((1 - f.age / f.life) * 3).ceil() / 3)),
  ];

  @override
  void render(ui.Canvas canvas) {
    if (renderPass == RenderPass.color || renderPass == RenderPass.normals) _bits.render(canvas, Layer.lit, renderPass, normals: normals);
  }
}
