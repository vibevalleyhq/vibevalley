import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/village/hits.dart';

const _plot = (x0: 0.0, y0: 10.0, x1: 20.0, y1: 30.0);
const _spot = (x0: 0.0, y0: 0.0, x1: 40.0, y1: 40.0);

VillageHitData _scene() => VillageHitData(
  sessions: {'w1': const Rect.fromLTWH(10, 10, 20, 20)},
  dog: const Rect.fromLTWH(0, 0, 50, 50),
  spots: const {'shop': _spot},
  plots: const {0: _plot},
);

void main() {
  test('a helper wins over the dog, a thing, and a bed', () {
    expect(villageHitAt(_scene(), const Offset(15, 15)), const VillageHitSession('w1'));
  });

  test('the dog wins over a thing and a bed; a thing wins over a bed', () {
    expect(villageHitAt(_scene(), const Offset(45, 45)), const VillageHitDog());
    expect(villageHitAt(_scene(), const Offset(5, 5)), const VillageHitDog());
    final withoutDog = VillageHitData(sessions: const {}, dog: Rect.zero, spots: _scene().spots, plots: _scene().plots);
    expect(villageHitAt(withoutDog, const Offset(5, 5)), const VillageHitSpot('shop'));
    final plotOnly = VillageHitData(sessions: const {}, dog: Rect.zero, spots: const {}, plots: _scene().plots);
    expect(villageHitAt(plotOnly, const Offset(5, 15)), const VillageHitPlot(0));
    // The plot's top edge has a few pixels of slack for its sign.
    expect(villageHitAt(plotOnly, const Offset(5, 7)), const VillageHitPlot(0));
    expect(villageHitAt(plotOnly, const Offset(5, 5.9)), isNull);
  });

  test('nothing under the point', () {
    expect(villageHitAt(_scene(), const Offset(200, 200)), isNull);
  });
}
