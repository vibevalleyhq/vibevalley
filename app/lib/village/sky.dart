import 'dart:math' as math;

typedef Rgb = (double, double, double);

class Grade {
  const Grade({required this.exposure, required this.saturation, required this.lift, required this.shadows, required this.highlights, required this.vignette});
  final double exposure;

  /// 1 as painted; more is more colourful.
  final double saturation;

  final double lift;

  final Rgb shadows;
  final Rgb highlights;

  final double vignette;
}

class Sky {
  const Sky({
    required this.ambient,
    required this.sunDir,
    required this.sun,
    required this.clouds,
    required this.mist,
    required this.mistAmount,
    required this.grade,
    required this.night,
  });

  final Rgb ambient;

  /// x right, y down the screen, z out of it; length 1.
  final Rgb sunDir;

  final Rgb sun;

  final double clouds;
  final Rgb mist;
  final double mistAmount;
  final Grade grade;

  /// 0 by day, 1 at night.
  final double night;
}

const _dayAmbient = (0.62, 0.64, 0.68);
const _duskAmbient = (0.66, 0.5, 0.46);
const _nightAmbient = (0.26, 0.32, 0.52);
const _sun = (1.0, 0.96, 0.86);
const _lowSun = (1.0, 0.62, 0.34);
const _moon = (0.55, 0.68, 1.0);
const _moonlight = 0.3;
const _mist = (0.9, 0.92, 0.94);
const _dayGrade = Grade(exposure: 1.06, saturation: 1.18, lift: 0.04, shadows: (0.02, 0.06, 0.1), highlights: (0.05, 0.035, -0.01), vignette: 0.16);
const _duskGrade = Grade(exposure: 1.06, saturation: 1.22, lift: 0.05, shadows: (0.14, 0.05, 0.02), highlights: (0.1, 0.04, -0.05), vignette: 0.22);
const _nightGrade = Grade(exposure: 1.08, saturation: 1.2, lift: 0.045, shadows: (0.01, 0.05, 0.14), highlights: (0.03, 0.05, 0.06), vignette: 0.3);

double _smooth(double a, double b, double x) {
  final k = ((x - a) / (b - a)).clamp(0.0, 1.0);
  return k * k * (3 - 2 * k);
}

/// 1 at full day, 0 at night; sunrise around 06:00, sunset around 19:00.
double sunOf(double tod) => _smooth(0.22, 0.3, tod) * (1 - _smooth(0.76, 0.84, tod));

double duskOf(double tod) {
  double at(double c) => math.max(0, 1 - (tod - c).abs() / 0.06);
  return math.max(at(0.26), at(0.8));
}

Rgb _normal(Rgb v) {
  final len = math.sqrt(v.$1 * v.$1 + v.$2 * v.$2 + v.$3 * v.$3);
  return len == 0 ? v : (v.$1 / len, v.$2 / len, v.$3 / len);
}

double _lerp(double a, double b, double k) => a + (b - a) * k;
Rgb _mix(Rgb a, Rgb b, double k) => (_lerp(a.$1, b.$1, k), _lerp(a.$2, b.$2, k), _lerp(a.$3, b.$3, k));
Rgb _scale(Rgb a, double k) => (a.$1 * k, a.$2 * k, a.$3 * k);
Grade _mixGrade(Grade a, Grade b, double k) => Grade(
  exposure: _lerp(a.exposure, b.exposure, k),
  saturation: _lerp(a.saturation, b.saturation, k),
  lift: _lerp(a.lift, b.lift, k),
  shadows: _mix(a.shadows, b.shadows, k),
  highlights: _mix(a.highlights, b.highlights, k),
  vignette: _lerp(a.vignette, b.vignette, k),
);

final _moonDir = _normal((0.35, -0.55, 0.75));

const _noon = 1.0;

Sky skyAt(double tod) {
  final day = sunOf(tod);
  final dusk = duskOf(tod);
  // The light falls from the top, as painted.
  final crossed = ((tod - 0.25) / 0.5).clamp(0.0, 1.0);
  final sunDir = _normal((-math.cos(math.pi * crossed), -0.5, 0.2 + 0.8 * math.sin(math.pi * crossed)));
  final dayAmbient = _mix(_dayAmbient, _duskAmbient, dusk);
  // What the ambient leaves to reach _noon on flat ground, the sun gives; a low sun gives it at a slant.
  final gain = (_noon - (dayAmbient.$1 + dayAmbient.$2 + dayAmbient.$3) / 3) / math.max(sunDir.$3, 0.3);
  final sunColor = _scale(_mix(_sun, _lowSun, dusk), gain);
  return Sky(
    ambient: _mix(_nightAmbient, dayAmbient, day),
    sunDir: _normal(_mix(_moonDir, sunDir, day)),
    sun: _mix(_scale(_moon, _moonlight), sunColor, day),
    clouds: 0.22 * day,
    mist: _mist,
    mistAmount: 0.3 * math.max(0, 1 - (tod - 0.29).abs() / 0.07),
    grade: _mixGrade(_nightGrade, _mixGrade(_dayGrade, _duskGrade, dusk), day),
    night: 1 - day,
  );
}

Rgb flatLight(Sky s) => (s.ambient.$1 + s.sun.$1 * s.sunDir.$3, s.ambient.$2 + s.sun.$2 * s.sunDir.$3, s.ambient.$3 + s.sun.$3 * s.sunDir.$3);
