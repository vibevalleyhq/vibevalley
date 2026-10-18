import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/overlays.dart';
import 'package:vibevalley/game/destinations.dart';

void main() {
  test('overlay owner preserves simultaneous layers and fixed stacking order', () {
    final c = ProviderContainer();
    addTearDown(c.dispose);
    final overlays = c.read(farmOverlaysProvider.notifier);
    overlays.menu(true);
    overlays.panel(FarmPanel.graphs);
    overlays.water('water');
    overlays.sow(2);
    overlays.review('review');
    overlays.select('inspect');
    final state = c.read(farmOverlaysProvider);
    expect(state.layers.map((x) => x.runtimeType), [InspectOverlay, ReviewOverlay, SowOverlay, WaterOverlay, PanelOverlay, MenuOverlay]);
    expect(state.any, isTrue);
    expect(state.soundFlags, {'panel': true, 'selected': true, 'sowing': true, 'watering': true});
    overlays.select('replacement');
    expect(c.read(farmOverlaysProvider).layers.length, 6);
    expect(c.read(selectedProvider), 'replacement');
    overlays.review(null);
    expect(c.read(farmOverlaysProvider).selected, 'replacement');
    expect(c.read(farmOverlaysProvider).reviewing, isNull);
    expect(c.read(farmOverlaysProvider).layers.last, isA<MenuOverlay>());
  });
  test('every yard resource id has one named destination', () {
    expect(YardPlace.values.map((x) => x.id).toSet().length, YardPlace.values.length);
    for (final place in YardPlace.values) {
      expect((place.panel != null) != (place.route != null), isTrue, reason: place.id);
      expect(place.label, isNotEmpty);
      expect(place.hint, isNotEmpty);
    }
    expect(YardPlace.shop.panel, FarmPanel.shop);
    expect(YardPlace.agents.route, '/agents');
  });
}
