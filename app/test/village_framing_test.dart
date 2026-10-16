// Where the village goes in windows of a few shapes (lib/village/framing.dart).

import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/village/framing.dart';

const village = Size(384, 256);

void main() {
  test('a window of the village\'s own shape holds it whole, edge to edge', () {
    final f = frameVillage(const Size(1152, 768), village);
    expect(f.scale, 3);
    expect(f.box, const Rect.fromLTWH(0, 0, 1152, 768));
    expect(f.shown, f.box);
  });

  test('a 16:10 window is covered one scale up, a little cut off the edges', () {
    final f = frameVillage(const Size(1440, 900), village);
    expect(f.scale, 4);
    expect(f.box, const Rect.fromLTWH(-48, -62, 1536, 1024));
    expect(f.shown, const Rect.fromLTWH(0, 0, 1440, 900));
  });

  test('a full-HD screen is covered at five, cutting only above and below', () {
    final f = frameVillage(const Size(1920, 1080), village);
    expect(f.scale, 5);
    expect(f.box, const Rect.fromLTWH(0, -100, 1920, 1280));
  });

  test('a window that would lose too much keeps a smaller scale and narrow bars', () {
    final f = frameVillage(const Size(1280, 800), village);
    expect(f.scale, 3);
    expect(f.box, const Rect.fromLTWH(64, 16, 1152, 768));
    expect(f.shown, f.box);
  });

  test('cut on one side and bars on the other', () {
    final f = frameVillage(const Size(1100, 900), village);
    expect(f.scale, 3);
    expect(f.box, const Rect.fromLTWH(-26, 66, 1152, 768));
    expect(f.shown, const Rect.fromLTWH(0, 66, 1100, 768));
  });

  test('a phone held upright shows the whole village across it, at least at one', () {
    expect(frameVillage(const Size(390, 844), village).scale, 1);
    expect(frameVillage(const Size(300, 600), village).scale, 1);
  });

  test('never more is cut than the limits', () {
    for (var w = 320.0; w <= 2600; w += 37) {
      for (var h = 300.0; h <= 1600; h += 29) {
        final f = frameVillage(Size(w, h), village);
        if (f.scale == 1) continue;
        expect(-f.box.left, lessThanOrEqualTo(f.box.width * villageCutAcross + 0.5), reason: '$w × $h');
        expect(-f.box.top, lessThanOrEqualTo(f.box.height * villageCutDown + 0.5), reason: '$w × $h');
      }
    }
  });
}
