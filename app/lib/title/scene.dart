// `--dart-define=VIBEVALLEY_TOD=0.9` picks another hour.

enum TitleScene { morning, day, evening, night }

String titleBackground(TitleScene scene) => 'assets/pixel/title-${scene.name}.jpg';

const _tod = String.fromEnvironment('VIBEVALLEY_TOD');

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

TitleScene startScene() => _opened ??= sceneAt(hourNow());

/// Fixed per scene.
typedef Mote = ({double x, double y, double size, double duration, double delay});

/// The same scene draws the same motes.
double Function() _random(int seed) => () {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const _fireflies = {TitleScene.morning: 0, TitleScene.day: 0, TitleScene.evening: 10, TitleScene.night: 26};

List<Mote> motesOf(TitleScene scene) {
  final r = _random(scene.name.length * 7919 + 17);
  // The lower half, away from the menu's column.
  return [
    for (var i = 0; i < _fireflies[scene]!; i++)
      (x: 30 + r() * 68, y: 48 + r() * 48, size: 3 + (r() + 0.5).floorToDouble(), duration: 5 + r() * 6, delay: -r() * 8),
  ];
}
