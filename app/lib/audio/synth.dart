// It renders what Chromium's Web Audio nodes would: the biquads (Web Audio's formulas, coefficients per sample), the exponential envelopes and glides, the
// oscillators (polyBLEP for Chromium's band-limited tables, square and sawtooth scaled to Chromium's peak), the limiter (Chromium's compressor kernel).
// test/shell_synth_test.dart holds it to the frozen renders in test/fixtures/sfx.json.

import 'dart:math' as math;
import 'dart:typed_data';

enum Wave { sine, square, sawtooth, triangle }

enum FilterType { lowpass, highpass, bandpass }

/// In seconds from the moment the sound plays.
abstract class Pen {
  void tone({
    double at = 0,
    required double freq,
    double? to,
    Wave type = Wave.sine,
    required double dur,
    required double gain,
    double attack = 0.005,
    double? lowpass,
  });

  /// `gain` above 1 makes up for the filter.
  void noise({
    double at = 0,
    required FilterType filter,
    required double freq,
    double? to,
    double q = 1,
    required double dur,
    required double gain,
    double attack = 0.005,
  });

  void bell({double at = 0, required double freq, required double dur, required double gain, List<(double, double)> partials = bellPartials});

  /// The same sequence for the same seed, so a sound is recognisable.
  double random();
}

typedef Recipe = void Function(Pen pen);

const bellPartials = [(1.0, 1.0), (2.01, 0.42), (3.03, 0.18), (4.17, 0.09)];

/// xorshift32; the seed changes per play to keep a little life in repeated sounds.
double Function() seeded(int seed) {
  var s = seed & 0xFFFFFFFF;
  if (s == 0) s = 1;
  return () {
    s = (s ^ (s << 13)) & 0xFFFFFFFF;
    s = s ^ (s >> 17);
    s = (s ^ (s << 5)) & 0xFFFFFFFF;
    return (s % 10000) / 10000;
  };
}

/// Fixed, so renders repeat.
double Function() noiseRandom() {
  var s = 0x2545f491;
  return () {
    s = (s ^ (s << 13)) & 0xFFFFFFFF;
    s = s ^ (s >> 17);
    s = (s ^ (s << 5)) & 0xFFFFFFFF;
    return s / 4294967296;
  };
}

Float32List makeNoise(int sampleRate) {
  final r = noiseRandom();
  final data = Float32List(sampleRate * 2);
  for (var i = 0; i < data.length; i++) {
    data[i] = r() * 2 - 1;
  }
  return data;
}

class _Param {
  _Param(this.value);
  final double value;
  final _events = <(bool, double, double)>[];

  void set(double v, double t) => _events.add((false, v, t));
  void exp(double v, double t) => _events.add((true, v, t));

  double at(double t) {
    var prevT = 0.0;
    var prevV = value;
    for (final (ramp, v, et) in _events) {
      if (t < et) return ramp ? prevV * math.pow(v / prevV, (t - prevT) / (et - prevT)).toDouble() : prevV;
      prevT = et;
      prevV = v;
    }
    return prevV;
  }
}

int _startOf(double t, int sr) => (t * sr).ceil();

double _blep(double t, double dt) {
  if (t < dt) {
    final x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    final x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/// Chromium scales its band-limited square and sawtooth so their peak, Gibbs overshoot included, is 1.
const _gibbs = 1 / 1.1789797444721672;

double _wave(Wave type, double phase, double dt) => switch (type) {
  Wave.sine => math.sin(2 * math.pi * phase),
  Wave.square => ((phase < 0.5 ? 1 : -1) + _blep(phase, dt) - _blep((phase + 0.5) % 1, dt)) * _gibbs,
  Wave.sawtooth => (2 * ((phase + 0.5) % 1) - 1 - _blep((phase + 0.5) % 1, dt)) * _gibbs,
  Wave.triangle => 1 - 4 * (((phase + 0.25) % 1) - 0.5).abs(),
};

void _biquad(Float64List x, FilterType type, _Param frequency, double q, int sr, int from) {
  var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
  for (var i = from; i < x.length; i++) {
    final f = math.min(math.max(frequency.at(i / sr), 0.0), sr / 2);
    final w = (2 * math.pi * f) / sr;
    final cos = math.cos(w);
    final sin = math.sin(w);
    final double b0, b1, b2, alpha;
    switch (type) {
      case FilterType.lowpass:
        alpha = sin / (2 * math.pow(10, q / 20));
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
      case FilterType.highpass:
        alpha = sin / (2 * math.pow(10, q / 20));
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
      case FilterType.bandpass:
        alpha = sin / (2 * q);
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
    }
    final a0 = 1 + alpha;
    final a1 = -2 * cos;
    final a2 = 1 - alpha;
    final v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    x[i] = v;
  }
}

sealed class _Voice {
  _Voice(this.t0, this.dur, this.gain, this.attack);
  final double t0;
  final double dur;
  final double gain;
  final double attack;

  double get end;

  _Param envelope() {
    final g = _Param(1)
      ..set(0.0001, t0)
      ..exp(math.max(0.0002, gain), t0 + math.min(attack, dur * 0.5))
      ..exp(0.0001, t0 + dur);
    return g;
  }
}

final class _Tone extends _Voice {
  _Tone(super.t0, super.dur, super.gain, super.attack, {required this.freq, required this.to, required this.type, required this.lowpass});
  final double freq;
  final double? to;
  final Wave type;
  final double? lowpass;

  @override
  double get end => t0 + dur + 0.05;
}

final class _Noise extends _Voice {
  _Noise(super.t0, super.dur, super.gain, super.attack, {required this.filter, required this.freq, required this.to, required this.q, required this.offset});
  final FilterType filter;
  final double freq;
  final double? to;
  final double q;
  final double offset;

  @override
  double get end => t0 + (dur + 0.05);
}

class _RenderPen implements Pen {
  _RenderPen(int seed) : _random = seeded(seed);
  final voices = <_Voice>[];
  final double Function() _random;

  @override
  double random() => _random();

  @override
  void tone({
    double at = 0,
    required double freq,
    double? to,
    Wave type = Wave.sine,
    required double dur,
    required double gain,
    double attack = 0.005,
    double? lowpass,
  }) => voices.add(_Tone(0 + at, dur, gain, attack, freq: freq, to: to, type: type, lowpass: lowpass));

  @override
  void noise({
    double at = 0,
    required FilterType filter,
    required double freq,
    double? to,
    double q = 1,
    required double dur,
    required double gain,
    double attack = 0.005,
  }) {
    // Each burst starts somewhere else in the noise, so repeated bursts do not sound identical.
    voices.add(_Noise(0 + at, dur, gain, attack, filter: filter, freq: freq, to: to, q: q, offset: random() * 1.5));
  }

  @override
  void bell({double at = 0, required double freq, required double dur, required double gain, List<(double, double)> partials = bellPartials}) {
    for (final (ratio, weight) in partials) {
      tone(at: at, freq: freq * ratio, gain: gain * weight, dur: dur / math.sqrt(ratio), attack: 0.002);
    }
  }
}

void _render(_Voice voice, Float64List master, Float32List noise, int sr) {
  final n = master.length;
  final out = Float64List(n);
  final from = _startOf(voice.t0, sr);
  final end = math.min(n, _startOf(voice.end, sr));
  switch (voice) {
    case _Tone():
      final f = _Param(440)..set(voice.freq, voice.t0);
      final to = voice.to;
      if (to != null && to != 0) f.exp(to, voice.t0 + voice.dur);
      var phase = 0.0;
      for (var i = from; i < end; i++) {
        final dt = f.at(i / sr) / sr;
        out[i] = _wave(voice.type, phase, dt);
        phase += dt;
        phase -= phase.floorToDouble();
      }
      final lowpass = voice.lowpass;
      if (lowpass != null && lowpass != 0) _biquad(out, FilterType.lowpass, _Param(lowpass), 1, sr, from);
    case _Noise():
      final read = (voice.offset * sr).floor();
      for (var i = from; i < end; i++) {
        final k = read + (i - from);
        out[i] = k < noise.length ? noise[k] : 0;
      }
      final f = _Param(350)..set(voice.freq, voice.t0);
      final to = voice.to;
      if (to != null && to != 0) f.exp(to, voice.t0 + voice.dur);
      _biquad(out, voice.filter, f, voice.q, sr, from);
  }
  final g = voice.envelope();
  for (var i = from; i < n; i++) {
    master[i] += out[i] * g.at(i / sr);
  }
}

/// Threshold -10 dB, knee 8, ratio 6, attack 3 ms, release 120 ms.
const _limiter = (threshold: -10.0, knee: 8.0, ratio: 6.0, attack: 0.003, release: 0.12);

/// `settled` starts the limiter as after a while of silence, as when a sound plays live; an offline render starts it cold.
Float32List renderRecipe(Recipe recipe, {double seconds = 2, int sampleRate = 44100, double volume = 0.55, int seed = 1, bool settled = false}) {
  final noise = makeNoise(sampleRate);
  final pen = _RenderPen(seed);
  recipe(pen);
  final master = Float64List((seconds * sampleRate).ceil());
  for (final v in pen.voices) {
    _render(v, master, noise, sampleRate);
  }
  for (var i = 0; i < master.length; i++) {
    master[i] *= volume;
  }
  return Float32List.fromList(compress(master, sampleRate, settled: settled));
}

double recipeSeconds(Recipe recipe) {
  final pen = _RenderPen(1);
  recipe(pen);
  return pen.voices.fold(0.0, (end, v) => math.max(end, v.end));
}

double _dbToLinear(double db) => math.pow(10, 0.05 * db).toDouble();
double _linearToDb(double x) => 20 * math.log(x) / math.ln10;

/// Chromium's DynamicsCompressorKernel: a static curve (linear to the threshold, an exponential knee, then the ratio),
/// a makeup gain of (1 / gain at 0 dB)^0.6, a detector with an instant attack and a fast release, a gain envelope
/// moved every 32 frames (adaptive release; attack by the largest step so far) and warped through a sine, and a
/// 6 ms look-ahead.
Float64List compress(Float64List x, int sr, {required bool settled}) {
  const o = _limiter;
  final linearThreshold = _dbToLinear(o.threshold);
  final kneeThresholdDb = o.threshold + o.knee;
  final kneeThreshold = _dbToLinear(kneeThresholdDb);
  final slope = 1 / o.ratio;
  double kneeCurve(double v, double k) => v < linearThreshold ? v : linearThreshold + (1 - math.exp(-k * (v - linearThreshold))) / k;
  double slopeAt(double v, double k) {
    if (v < linearThreshold) return 1;
    final v2 = v * 1.001;
    return (_linearToDb(kneeCurve(v2, k)) - _linearToDb(kneeCurve(v, k))) / (_linearToDb(v2) - _linearToDb(v));
  }

  var minK = 0.1, maxK = 10000.0, k = 5.0;
  for (var i = 0; i < 15; i++) {
    if (slopeAt(kneeThreshold, k) < slope) {
      maxK = k;
    } else {
      minK = k;
    }
    k = math.sqrt(minK * maxK);
  }
  final yKneeThresholdDb = _linearToDb(kneeCurve(kneeThreshold, k));
  double saturate(double v) => v < kneeThreshold ? kneeCurve(v, k) : _dbToLinear(yKneeThresholdDb + slope * (_linearToDb(v) - kneeThresholdDb));
  final masterGain = math.pow(1 / saturate(1), 0.6);
  final attackFrames = math.max(0.001, o.attack) * sr;
  final releaseFrames = sr * o.release;
  final satReleaseFrames = 0.0025 * sr;
  final [y1, y2, y3, y4] = [
    for (final z in [0.09, 0.16, 0.42, 0.98]) releaseFrames * z,
  ];
  final kA = 0.9999999999999998 * y1 + 1.8432219684323923e-16 * y2 - 1.9373394351676423e-16 * y3 + 8.824516011816245e-18 * y4;
  final kB = -1.5788320352845888 * y1 + 2.3305837032074286 * y2 - 0.9141194204840429 * y3 + 0.1623677525612032 * y4;
  final kC = 0.5334142869106424 * y1 - 1.272736789213631 * y2 + 0.9258856042207512 * y3 - 0.18656310191776226 * y4;
  final kD = 0.08783463138207234 * y1 - 0.1694162967925622 * y2 + 0.08588057951595272 * y3 - 0.00429891410546283 * y4;
  final kE = -0.042416883008123074 * y1 + 0.1115693827987602 * y2 - 0.09764676325265872 * y3 + 0.028494263462021576 * y4;
  final delay = (0.006 * sr).floor();

  final out = Float64List(x.length);
  var detectorAverage = settled ? 1.0 : 0.0;
  var compressorGain = 1.0;
  var maxAttackDiffDb = -1.0;
  for (var start = 0; start < x.length; start += 32) {
    final scaledDesiredGain = math.asin(detectorAverage) / (0.5 * math.pi);
    var diffDb = _linearToDb(compressorGain / scaledDesiredGain);
    final double envelopeRate;
    if (scaledDesiredGain > compressorGain) {
      maxAttackDiffDb = -1;
      if (!diffDb.isFinite) diffDb = -1;
      final v = 0.25 * (math.min(math.max(diffDb, -12.0), 0.0) + 12);
      final v2 = v * v;
      final frames = kA + kB * v + kC * v2 + kD * v2 * v + kE * v2 * v2;
      envelopeRate = _dbToLinear(5 / frames);
    } else {
      if (!diffDb.isFinite) diffDb = 1;
      if (maxAttackDiffDb == -1 || maxAttackDiffDb < diffDb) maxAttackDiffDb = diffDb;
      envelopeRate = 1 - math.pow(0.25 / math.max(0.5, maxAttackDiffDb), 1 / attackFrames).toDouble();
    }
    for (var i = start; i < math.min(start + 32, x.length); i++) {
      final input = x[i].abs();
      final attenuation = input <= 0.0001 ? 1.0 : saturate(input) / input;
      final attenuationDb = math.max(2.0, -_linearToDb(attenuation));
      final satReleaseRate = _dbToLinear(attenuationDb / satReleaseFrames) - 1;
      detectorAverage += (attenuation - detectorAverage) * (attenuation > detectorAverage ? satReleaseRate : 1);
      detectorAverage = math.min(1.0, detectorAverage);
      if (envelopeRate < 1) {
        compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate;
      } else {
        compressorGain = math.min(1.0, compressorGain * envelopeRate);
      }
      final gain = masterGain * math.sin(0.5 * math.pi * compressorGain);
      out[i] = (i >= delay ? x[i - delay] : 0) * gain;
    }
  }
  return out;
}

Uint8List toWav(Float32List all, {int sampleRate = 44100, double tail = 0.05}) {
  var last = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].abs() > 0.001) last = i;
  }
  final n = math.min(all.length, last + (sampleRate * tail).round());
  final bytes = ByteData(44 + n * 2);
  void text(int at, String s) {
    for (var i = 0; i < s.length; i++) {
      bytes.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  text(0, 'RIFF');
  bytes.setUint32(4, 36 + n * 2, Endian.little);
  text(8, 'WAVE');
  text(12, 'fmt ');
  bytes.setUint32(16, 16, Endian.little);
  bytes.setUint16(20, 1, Endian.little);
  bytes.setUint16(22, 1, Endian.little);
  bytes.setUint32(24, sampleRate, Endian.little);
  bytes.setUint32(28, sampleRate * 2, Endian.little);
  bytes.setUint16(32, 2, Endian.little);
  bytes.setUint16(34, 16, Endian.little);
  text(36, 'data');
  bytes.setUint32(40, n * 2, Endian.little);
  for (var i = 0; i < n; i++) {
    // The scaled value truncated toward zero.
    bytes.setInt16(44 + i * 2, (all[i].clamp(-1.0, 1.0) * 0x7fff).truncate(), Endian.little);
  }
  return bytes.buffer.asUint8List();
}

/// How loud a rendered sound is: the highest sample (dBFS), the K-weighted level of the loudest 100 ms (BS.1770, for
/// sounds shorter than its 400 ms window), and until when it is above -60 dBFS.
typedef Measure = ({double peak, double loudness, double seconds});

/// JavaScript's Math.round: halves go up, also below zero.
double _jsRound(double x) => (x + 0.5).floorToDouble();

typedef _Coefficients = (double, double, double, double, double);

List<_Coefficients> _kWeighting(int fs) {
  _Coefficients shelf(double fc, double q, double db) {
    final a = math.pow(10, db / 40).toDouble();
    final w = (2 * math.pi * fc) / fs;
    final cos = math.cos(w);
    final alpha = math.sin(w) / (2 * q);
    final root = 2 * math.sqrt(a) * alpha;
    final a0 = a + 1 - (a - 1) * cos + root;
    return (
      (a * (a + 1 + (a - 1) * cos + root)) / a0,
      (-2 * a * (a - 1 + (a + 1) * cos)) / a0,
      (a * (a + 1 + (a - 1) * cos - root)) / a0,
      (2 * (a - 1 - (a + 1) * cos)) / a0,
      (a + 1 - (a - 1) * cos - root) / a0,
    );
  }

  _Coefficients highpass(double fc, double q) {
    final w = (2 * math.pi * fc) / fs;
    final cos = math.cos(w);
    final alpha = math.sin(w) / (2 * q);
    final a0 = 1 + alpha;
    return ((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  return [shelf(1681.97, 0.7072, 4), highpass(38.135, 0.5003)];
}

Float32List _filter(Float32List x, _Coefficients c) {
  final (b0, b1, b2, a1, a2) = c;
  final y = Float32List(x.length);
  var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
  for (var i = 0; i < x.length; i++) {
    final v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

double _db(double power) => _jsRound(10 * math.log(math.max(power, 1e-12)) / math.ln10 * 10) / 10;

Measure measure(Float32List x, {int sampleRate = 44100}) {
  final fs = sampleRate;
  var peak = 0.0;
  var last = 0;
  for (var i = 0; i < x.length; i++) {
    final v = x[i].abs();
    if (v > peak) peak = v;
    if (v > 0.001) last = i;
  }
  final y = _kWeighting(fs).fold(x, _filter);
  final window = _jsRound(fs * 0.1).toInt();
  final hop = _jsRound(fs * 0.01).toInt();
  var sum = 0.0;
  for (var i = 0; i < math.min(window, y.length); i++) {
    sum += y[i] * y[i];
  }
  var loudest = sum;
  for (var start = 0; start + window + hop <= y.length; start += hop) {
    for (var i = start; i < start + hop; i++) {
      sum += y[i + window] * y[i + window] - y[i] * y[i];
    }
    loudest = math.max(loudest, sum);
  }
  return (peak: _db(peak * peak), loudness: _jsRound((_db(loudest / window) - 0.691) * 10) / 10, seconds: _jsRound((last / fs) * 100) / 100);
}
