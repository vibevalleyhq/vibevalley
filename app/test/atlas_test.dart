// The sprite atlas reads the web page's manifest (assets/pixel/sprites.json): sizes and anchors in art pixels.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/sprites/atlas.dart';

void main() {
  final atlas = SpriteAtlas.parse(File('assets/pixel/sprites.json').readAsStringSync());

  test('the map is the level: 384 art pixels wide, drawn twice as dense', () {
    expect(atlas.density, 2);
    expect(atlas['map'].w, SpriteAtlas.levelWidth);
  });

  test('every sprite has its picture beside the manifest', () {
    final missing = [
      for (final n in atlas.names)
        if (!File(atlas[n].asset).existsSync()) n,
    ];
    expect(missing, isEmpty);
  });

  test('a variant falls back to the plainer sprite', () {
    expect(atlas.first(['nope-such-sprite', 'icon-board']).name, 'icon-board');
    expect(atlas.has('nope-such-sprite'), isFalse);
  });
}
