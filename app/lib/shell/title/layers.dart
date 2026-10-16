// What moves over the title's picture (web/src/title/layers.ts; design/pixel title-clouds, title-smoke,
// title-dandelion, title-plants, cut by title_layers.py): clouds crossing the sky, smoke rising from the farmhouse
// chimney, plants along the bottom swaying, seeds blowing off the dandelions. Everything is placed in the scene's own
// pixels (1536 x 1024, as the pictures are drawn), so it stays put on the picture however the screen crops it. Each
// scene tints them to its light: dawn's warmth, evening's glow, night's dark (the page's CSS filters, as colour
// matrices).

import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'scene.dart';

/// The scene's size: where things are placed is in these pixels.
const sceneW = 1536.0, sceneH = 1024.0;

/// Each sprite's size in the scene's pixels (assets/title/sprites.json).
typedef TitleSprites = Map<String, ({double w, double h})>;

final titleSpritesProvider = FutureProvider<TitleSprites>((ref) async {
  final raw = jsonDecode(await rootBundle.loadString('assets/title/sprites.json')) as Map<String, dynamic>;
  return {
    for (final MapEntry(:key, :value) in raw.entries) key: (w: ((value as Map<String, dynamic>)['w'] as num).toDouble(), h: (value['h'] as num).toDouble()),
  };
});

String titleSpriteAsset(String name) => 'assets/title/$name.png';

/// A sprite's size as a share of the scene (so it scales with it).
({double w, double h}) spriteShare(TitleSprites sizes, String name, [double scale = 1]) {
  final s = sizes[name]!;
  return (w: s.w * scale / sceneW, h: s.h * scale / sceneH);
}

/// Where the farmhouse chimney's mouth is, the same in every scene.
const chimney = (x: 1068 / sceneW, y: 330 / sceneH);

typedef Cloud = ({String sprite, double y, double scale, double duration, double delay});

/// High in the sky, above where the smoke thins out. Seconds to cross; a negative delay is how far across it starts.
const clouds = <Cloud>[
  (sprite: 'cloud-big-1', y: -0.01, scale: 0.45, duration: 160, delay: -40),
  (sprite: 'cloud-wisp-1', y: 0.06, scale: 0.45, duration: 120, delay: -95),
  (sprite: 'cloud-mid-2', y: 0.015, scale: 0.38, duration: 190, delay: -150),
];

/// A plant: its middle (a share of the width; it stands on the bottom edge), seconds per sway, degrees each way.
typedef Plant = ({String sprite, double x, double scale, double sway, double lean});

/// Left and middle only: the farmer and the dog stand at the right.
const plants = <Plant>[
  (sprite: 'fern', x: 0.02, scale: 0.5, sway: 4.6, lean: 1.5),
  (sprite: 'grass-tall', x: 0.11, scale: 0.45, sway: 3.4, lean: 2.5),
  (sprite: 'dandelion-3', x: 0.2, scale: 0.42, sway: 3.9, lean: 3),
  (sprite: 'grass-daisy', x: 0.31, scale: 0.36, sway: 4.2, lean: 2),
  (sprite: 'dandelion-2', x: 0.47, scale: 0.36, sway: 3.6, lean: 3),
  (sprite: 'grass-yellow', x: 0.985, scale: 0.4, sway: 4, lean: 2),
];

/// Seeds blow off the dandelions (the plants' 3rd and 5th) up and to the right across the scene.
const seeds = <({String sprite, double from, double duration, double delay})>[
  (sprite: 'seed-1', from: 0.2, duration: 16, delay: -2),
  (sprite: 'seed-2', from: 0.47, duration: 19, delay: -9),
  (sprite: 'seed-3', from: 0.2, duration: 22, delay: -15),
  (sprite: 'seed-4', from: 0.47, duration: 17, delay: -5),
  (sprite: 'seed-2', from: 0.2, duration: 25, delay: -20),
];

/// The puffs, one after another out of the chimney: small and pale, close together, so they read as one plume.
const puffs = <({String sprite, double scale})>[
  (sprite: 'puff-1', scale: 0.3),
  (sprite: 'puff-2', scale: 0.26),
  (sprite: 'wisp-1', scale: 0.32),
  (sprite: 'puff-1', scale: 0.28),
  (sprite: 'puff-2', scale: 0.3),
  (sprite: 'wisp-2', scale: 0.26),
  (sprite: 'puff-1', scale: 0.32),
];
const puffSeconds = 8.0;

/// Where the farmer and the pet stand (their feet's middle), and how big they are drawn: as they were painted.
const manager = (x: 1327 / sceneW, bottom: 898 / sceneH, scale: 0.73);
const petSpot = (x: 1212 / sceneW, bottom: 918 / sceneH);

/// Each pet's frames drawn sitting about as tall as the dog was painted.
const petScale = {'dog': 0.59, 'ragdoll': 0.69, 'bluecat': 0.55};

/// The farmer's pose at each hour: stretching at dawn, shading his eyes at noon, at ease at dusk, a lantern at night.
String managerPose(TitleScene scene) => 'manager-${scene.name}';

/// Awake, a pet sits and swishes its tail a few times, then looks back at you for a moment; at night it sleeps.
const petRound = <({String frame, int ms})>[
  (frame: 'sit', ms: 1400),
  (frame: 'tail', ms: 500),
  (frame: 'sit', ms: 500),
  (frame: 'tail', ms: 500),
  (frame: 'sit', ms: 2600),
  (frame: 'look', ms: 2200),
  (frame: 'sit', ms: 1800),
  (frame: 'tail', ms: 600),
];

// ── The CSS filters, as colour matrices (Filter Effects: sepia, saturate, hue-rotate, brightness) ──

sealed class Css {
  const Css();
  List<double> get m;
}

final class Sepia extends Css {
  const Sepia(this.a);
  final double a;
  @override
  List<double> get m {
    final b = 1 - a;
    return [
      0.393 + 0.607 * b,
      0.769 - 0.769 * b,
      0.189 - 0.189 * b,
      0.349 - 0.349 * b,
      0.686 + 0.314 * b,
      0.168 - 0.168 * b,
      0.272 - 0.272 * b,
      0.534 - 0.534 * b,
      0.131 + 0.869 * b,
    ];
  }
}

final class Saturate extends Css {
  const Saturate(this.s);
  final double s;
  @override
  List<double> get m => [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
}

final class HueRotate extends Css {
  const HueRotate(this.deg);
  final double deg;
  @override
  List<double> get m {
    final c = math.cos(deg * math.pi / 180), s = math.sin(deg * math.pi / 180);
    return [
      0.213 + c * 0.787 - s * 0.213,
      0.715 - c * 0.715 - s * 0.715,
      0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143,
      0.715 + c * 0.285 + s * 0.140,
      0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787,
      0.715 - c * 0.715 + s * 0.715,
      0.072 + c * 0.928 + s * 0.072,
    ];
  }
}

final class Brightness extends Css {
  const Brightness(this.b);
  final double b;
  @override
  List<double> get m => [b, 0, 0, 0, b, 0, 0, 0, b];
}

/// A CSS filter list as one colour filter: the first function applies first. Null for `none`.
ColorFilter? cssFilter(List<Css> list) {
  if (list.isEmpty) return null;
  var m = const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (final f in list) {
    final a = f.m;
    m = [
      for (var r = 0; r < 3; r++)
        for (var c = 0; c < 3; c++) a[r * 3] * m[c] + a[r * 3 + 1] * m[3 + c] + a[r * 3 + 2] * m[6 + c],
    ];
  }
  return ColorFilter.matrix([m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0]);
}

/// Each scene's light on what moves, and whether it has seeds blowing (none at night).
typedef Light = ({List<Css> sky, List<Css> ground, List<Css> smoke, bool seeds});

const lights = <TitleScene, Light>{
  TitleScene.morning: (
    sky: [Sepia(0.35), Saturate(1.4), HueRotate(-25), Brightness(1.03)],
    ground: [Sepia(0.15), Brightness(1.02)],
    smoke: [Brightness(1.05)],
    seeds: true,
  ),
  TitleScene.day: (sky: [], ground: [], smoke: [Brightness(1.1)], seeds: true),
  TitleScene.evening: (
    sky: [Sepia(0.6), Saturate(2.2), HueRotate(-35), Brightness(0.98)],
    ground: [Sepia(0.45), Saturate(1.3), HueRotate(-12), Brightness(0.88)],
    smoke: [Sepia(0.4), Saturate(1.4), HueRotate(-20)],
    seeds: true,
  ),
  TitleScene.night: (
    sky: [Brightness(0.32), Saturate(0.6), HueRotate(25)],
    ground: [Brightness(0.38), Saturate(0.7), HueRotate(20)],
    smoke: [Brightness(0.55), Saturate(0.6), HueRotate(20)],
    seeds: false,
  ),
};
