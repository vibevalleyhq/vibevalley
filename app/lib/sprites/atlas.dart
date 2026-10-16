// The pixel village's drawings: one PNG per sprite in assets/pixel, and sprites.json with each one's size and anchor
// (design/pixel/process.py writes both for the web page; assets/pixel links there). Sizes in the manifest are in the
// drawing's pixels; the pictures are drawn DENSITY times denser than the village's art pixels, so a sprite's size in
// art pixels is its manifest size over DENSITY (web/src/pixel/density.ts).

import 'dart:convert';

import 'package:flutter/widgets.dart';

/// One sprite: its picture's size and anchor (the point that stands on the ground), in art pixels.
class SpriteInfo {
  const SpriteInfo(this.name, {required this.w, required this.h, required this.ax, required this.ay, this.yard});
  final String name;
  final double w;
  final double h;
  final double ax;
  final double ay;

  /// An island's yard (the map page's), where its plots stand: from the picture's top-left, in art pixels.
  final Rect? yard;

  String get asset => 'assets/pixel/$name.png';
}

class SpriteAtlas {
  SpriteAtlas._(this._sprites, this.density);

  final Map<String, SpriteInfo> _sprites;

  /// Drawing pixels per art pixel: the map's width over the level's (384 art pixels).
  final double density;

  static const levelWidth = 384.0;

  static Future<SpriteAtlas> load(AssetBundle bundle) async => parse(await bundle.loadString('assets/pixel/sprites.json'));

  static SpriteAtlas parse(String manifest) {
    final raw = jsonDecode(manifest) as Map<String, dynamic>;
    final density = ((raw['map'] as Map<String, dynamic>)['w'] as num) / levelWidth;
    double art(Map<String, dynamic> m, String k) => (m[k] as num) / density;
    Rect? box(Object? v) => switch (v) {
      [final num x0, final num y0, final num x1, final num y1] => Rect.fromLTRB(x0 / density, y0 / density, x1 / density, y1 / density),
      _ => null,
    };
    return SpriteAtlas._({
      for (final MapEntry(:key, :value) in raw.entries)
        key: SpriteInfo(
          key,
          w: art(value as Map<String, dynamic>, 'w'),
          h: art(value, 'h'),
          ax: art(value, 'ax'),
          ay: art(value, 'ay'),
          yard: box(value['yard']),
        ),
    }, density.toDouble());
  }

  bool has(String name) => _sprites.containsKey(name);

  SpriteInfo operator [](String name) => _sprites[name] ?? (throw ArgumentError('no sprite $name'));

  /// The first of `names` that exists: for variants that fall back to a plainer sprite.
  SpriteInfo first(List<String> names) => this[names.firstWhere(has, orElse: () => names.last)];

  Iterable<String> get names => _sprites.keys;
}

/// A sprite drawn crisp (no smoothing) at `scale` screen pixels per art pixel.
class PixelSprite extends StatelessWidget {
  const PixelSprite(this.sprite, {super.key, this.scale = 2});
  final SpriteInfo sprite;
  final double scale;

  @override
  Widget build(BuildContext context) =>
      Image.asset(sprite.asset, width: sprite.w * scale, height: sprite.h * scale, filterQuality: FilterQuality.none, isAntiAlias: false, fit: BoxFit.fill);
}
