// The title screen's scene (web/src/title/scene.ts): the farm at the hour it is (morning, day, evening, night; design/
// pixel title-*), and the fireflies over its fields at dusk and night (the rest that moves is layers.dart).
// `--dart-define=VIBEVALLEY_TOD=0.9` picks another hour, as `?tod=0.9` does on the web page.

enum TitleScene { morning, day, evening, night }

/// The scene's picture (assets/pixel links to the web page's web/src/pixel/assets).
String titleBackground(TitleScene scene) => 'assets/pixel/title-${scene.name}.jpg';

const _tod = String.fromEnvironment('VIBEVALLEY_TOD');

/// The hour now, or the one VIBEVALLEY_TOD asks for.
double hourNow([DateTime? now]) {
  final tod = double.tryParse(_tod);
  if (tod != null && tod > 0 && tod < 1) return tod * 24;
  final t = now ?? DateTime.now();
  return t.hour + t.minute / 60;
}

TitleScene sceneAt(double hour) {
  if (hour >= 5 && hour < 9) return TitleScene.morning;
  if (hour >= 9 && hour < 16) return TitleScene.day;
  if (hour >= 16 && hour < 19.5) return TitleScene.evening;
  return TitleScene.night;
}

TitleScene? _opened;

/// The scene the app opened at: the title screen keeps it, and startup loads its picture.
TitleScene startScene() => _opened ??= sceneAt(hourNow());

/// A firefly: where it starts (a share of the scene, in percent), how big (px), how slow. Fixed per scene.
typedef Mote = ({double x, double y, double size, double duration, double delay});

/// A small seeded random (scene.ts random): the same scene draws the same motes.
double Function() _random(int seed) => () {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const _fireflies = {TitleScene.morning: 0, TitleScene.day: 0, TitleScene.evening: 10, TitleScene.night: 26};

List<Mote> motesOf(TitleScene scene) {
  final r = _random(scene.name.length * 7919 + 17);
  // Fireflies keep to the fields: the lower half, away from the menu's column.
  return [
    for (var i = 0; i < _fireflies[scene]!; i++)
      (x: 30 + r() * 68, y: 48 + r() * 48, size: 3 + (r() + 0.5).floorToDouble(), duration: 5 + r() * 6, delay: -r() * 8),
  ];
}
