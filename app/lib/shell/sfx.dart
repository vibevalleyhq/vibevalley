// The farm's sound effects (web/src/game/sfx.ts), synthesized (synth.dart): no audio files. Each sound is a recipe
// of tones, filtered noise and bells. The debug console's 音效 tab plays every one.
//
// Levels come in three steps of loudness, as the web page measured them with hb.soundStats(): clicks about -28,
// work on the beds and state changes about -24, rewards about -20. Kept below speech on purpose: once voice is on,
// the microphone sits next to these. The recipes are the web page's; change them there and here together
// (tool/sfx_fixture.ts and test/shell_synth_test.dart check that they still agree).

import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import 'synth.dart';

/// A handful of tiny noise bursts spread over `span` seconds: rustling leaves, crumbling soil, sparkles.
void grains(
  Pen pen, {
  double at = 0,
  required double span,
  required int count,
  required double freq,
  required double gain,
  double q = 2,
  FilterType filter = FilterType.bandpass,
}) {
  for (var i = 0; i < count; i++) {
    // In the order the web page draws them: frequency, start, length, level.
    final f = freq * (0.8 + pen.random() * 0.5);
    final start = at + pen.random() * span;
    final dur = 0.03 + pen.random() * 0.05;
    final g = gain * (0.6 + pen.random() * 0.4);
    pen.noise(filter: filter, freq: f, q: q, at: start, dur: dur, gain: g);
  }
}

/// Every sound, by name.
final Map<String, Recipe> sounds = {
  // A click that does something: a soft wooden tock.
  'tap': (pen) {
    pen.tone(freq: 620, to: 480, type: Wave.triangle, dur: 0.06, gain: 1.9);
    pen.noise(filter: FilterType.highpass, freq: 3000, dur: 0.025, gain: 0.59);
  },
  // A click that does nothing: two dull knocks.
  'nope': (pen) {
    pen.tone(freq: 180, to: 140, dur: 0.09, gain: 0.42);
    pen.noise(filter: FilterType.lowpass, freq: 500, dur: 0.06, gain: 0.23);
    pen.tone(at: 0.11, freq: 150, to: 115, dur: 0.11, gain: 0.38);
    pen.noise(at: 0.11, filter: FilterType.lowpass, freq: 420, dur: 0.07, gain: 0.19);
  },
  // Picking up a tool: a wooden clack.
  'pick': (pen) {
    pen.noise(filter: FilterType.bandpass, freq: 1900, q: 5, dur: 0.035, gain: 4.24);
    pen.tone(freq: 880, to: 700, dur: 0.05, gain: 1.55);
    pen.noise(at: 0.05, filter: FilterType.bandpass, freq: 1500, q: 5, dur: 0.03, gain: 1.93);
  },
  // A panel or a dock opening: a short rising swish.
  'open': (pen) => pen.noise(filter: FilterType.bandpass, freq: 700, to: 2600, q: 1.4, dur: 0.22, gain: 0.72, attack: 0.08),
  // …and closing: the same swish falling.
  'close': (pen) => pen.noise(filter: FilterType.bandpass, freq: 2400, to: 650, q: 1.4, dur: 0.2, gain: 0.62, attack: 0.05),
  // 浇水: water pouring, then drops landing on the soil.
  'water': (pen) {
    pen.noise(filter: FilterType.bandpass, freq: 900, to: 1500, q: 1.1, dur: 0.75, gain: 0.53, attack: 0.12);
    pen.noise(filter: FilterType.highpass, freq: 5000, dur: 0.6, gain: 0.1, attack: 0.1);
    for (var i = 0; i < 6; i++) {
      final at = 0.15 + pen.random() * 0.6;
      final freq = 1100 + pen.random() * 900;
      pen.tone(at: at, freq: freq, to: freq * 0.55, dur: 0.06, gain: 0.23);
    }
  },
  // 杀虫: two quick pumps of the sprayer.
  'spray': (pen) {
    for (final at in [0.0, 0.22]) {
      pen.noise(at: at, filter: FilterType.highpass, freq: 3800, dur: 0.17, gain: 0.23, attack: 0.01);
      pen.noise(at: at, filter: FilterType.bandpass, freq: 6500, q: 2, dur: 0.12, gain: 0.1);
    }
  },
  // 除草: a root pulled out of the ground, and the leaves rustling.
  'weed': (pen) {
    pen.tone(freq: 210, to: 90, dur: 0.12, gain: 1.61);
    grains(pen, at: 0.04, span: 0.22, count: 7, freq: 2600, gain: 0.56);
  },
  // 收获: a rustle of stalks, then a little chime.
  'harvest': (pen) {
    grains(pen, span: 0.25, count: 9, freq: 3200, gain: 0.16);
    pen.bell(at: 0.18, freq: 1047, dur: 0.6, gain: 0.19);
    pen.bell(at: 0.28, freq: 1319, dur: 0.7, gain: 0.16);
  },
  // 铲除: the shovel biting into soil, and the soil falling back.
  'shovel': (pen) {
    pen.noise(filter: FilterType.lowpass, freq: 450, dur: 0.16, gain: 1.79, attack: 0.004);
    pen.tone(freq: 120, to: 55, dur: 0.16, gain: 1.49);
    grains(pen, at: 0.1, span: 0.3, count: 8, freq: 900, gain: 0.48, filter: FilterType.lowpass);
  },
  // A seed going in: a soft pop.
  'plant': (pen) {
    pen.tone(freq: 320, to: 760, dur: 0.09, gain: 1.34);
    pen.noise(at: 0.03, filter: FilterType.lowpass, freq: 600, dur: 0.06, gain: 0.68);
  },
  // A bed ripens: a twinkle going up.
  'ripe': (pen) {
    final notes = [1568.0, 2093.0, 2637.0];
    for (var i = 0; i < notes.length; i++) {
      pen.bell(at: i * 0.07, freq: notes[i], dur: 0.45, gain: 0.12);
    }
  },
  // Bugs on a bed: a short buzz.
  'bug': (pen) {
    pen.tone(freq: 190, type: Wave.sawtooth, dur: 0.32, gain: 0.48, attack: 0.02, lowpass: 1100);
    pen.tone(freq: 196, type: Wave.sawtooth, dur: 0.32, gain: 0.38, attack: 0.02, lowpass: 1100);
    pen.tone(at: 0.36, freq: 210, type: Wave.sawtooth, dur: 0.2, gain: 0.38, attack: 0.02, lowpass: 1000);
  },
  // Coins: the classic two-step ching, with a bell on top.
  'coin': (pen) {
    pen.tone(freq: 988, type: Wave.square, dur: 0.08, gain: 0.23, lowpass: 4000);
    pen.tone(at: 0.07, freq: 1319, type: Wave.square, dur: 0.25, gain: 0.23, lowpass: 4500);
    pen.bell(at: 0.07, freq: 2637, dur: 0.3, gain: 0.11);
  },
  // Level up: a rising arpeggio landing on a bell chord.
  'levelUp': (pen) {
    final notes = [523.0, 659.0, 784.0, 1047.0];
    for (var i = 0; i < notes.length; i++) {
      pen.tone(at: i * 0.09, freq: notes[i], type: Wave.triangle, dur: 0.24, gain: 0.23);
    }
    pen.bell(at: 0.38, freq: 1047, dur: 1.1, gain: 0.16);
    pen.bell(at: 0.38, freq: 1319, dur: 1.1, gain: 0.12);
    pen.bell(at: 0.38, freq: 1568, dur: 1.1, gain: 0.1);
  },
  // An achievement: two bells and a sparkle.
  'achievement': (pen) {
    pen.bell(freq: 784, dur: 0.6, gain: 0.21);
    pen.bell(at: 0.12, freq: 1175, dur: 0.9, gain: 0.21);
    grains(pen, at: 0.15, span: 0.35, count: 6, freq: 7000, gain: 0.064, q: 4);
  },
  // A helper walks onto the farm: a light little hop.
  'arrive': (pen) {
    pen.tone(freq: 440, to: 520, type: Wave.triangle, dur: 0.08, gain: 0.48);
    pen.tone(at: 0.09, freq: 660, to: 760, type: Wave.triangle, dur: 0.1, gain: 0.43);
  },
  // A poke at the grass or a bush: a short rustle of leaves.
  'rustle': (pen) {
    grains(pen, span: 0.18, count: 8, freq: 3000, gain: 0.5);
    grains(pen, at: 0.05, span: 0.15, count: 4, freq: 1800, gain: 0.3);
  },
  // A poke at the pond: a small plop and a couple of drops.
  'splash': (pen) {
    pen.tone(freq: 720, to: 260, dur: 0.09, gain: 1.1);
    pen.noise(filter: FilterType.bandpass, freq: 1400, q: 1.2, dur: 0.12, gain: 0.43);
    pen.tone(at: 0.12, freq: 1300, to: 800, dur: 0.05, gain: 0.3);
    pen.tone(at: 0.19, freq: 1100, to: 700, dur: 0.05, gain: 0.24);
  },
  // A poke at the dirt: a soft thump and a puff of dust.
  'thud': (pen) {
    pen.tone(freq: 150, to: 80, dur: 0.09, gain: 1.3);
    pen.noise(filter: FilterType.lowpass, freq: 700, dur: 0.08, gain: 0.56);
  },
  // The dog barks, two small happy woofs.
  'woof': (pen) {
    pen.tone(freq: 560, to: 360, type: Wave.sawtooth, dur: 0.08, gain: 0.44, attack: 0.008, lowpass: 1500);
    pen.tone(at: 0.13, freq: 620, to: 380, type: Wave.sawtooth, dur: 0.1, gain: 0.41, attack: 0.008, lowpass: 1500);
  },
  // The dog jumps: one short, high yip.
  'yip': (pen) => pen.tone(freq: 900, to: 620, type: Wave.sawtooth, dur: 0.09, gain: 1.45, attack: 0.005, lowpass: 2400),
  // The dog, pleased: quick soft pants.
  'pant': (pen) {
    final ats = [0.0, 0.12, 0.24];
    for (var i = 0; i < ats.length; i++) {
      pen.noise(at: ats[i], filter: FilterType.bandpass, freq: 1500.0 - i * 120, q: 1.6, dur: 0.08, gain: 1.4);
    }
  },
  // A cat (the pet, when it is one): a meow, up and down.
  'meow': (pen) {
    pen.tone(freq: 620, to: 980, type: Wave.triangle, dur: 0.14, gain: 0.5, attack: 0.02, lowpass: 2600);
    pen.tone(at: 0.13, freq: 980, to: 560, type: Wave.triangle, dur: 0.22, gain: 0.45, lowpass: 2400);
  },
  // …a short, high mew (its jump).
  'mew': (pen) => pen.tone(freq: 1100, to: 1400, type: Wave.triangle, dur: 0.1, gain: 0.5, attack: 0.01, lowpass: 3000),
  // …and a purr, pleased: a low, rough rumble.
  'purr': (pen) {
    for (var i = 0; i < 12; i++) {
      pen.noise(at: i * 0.045, filter: FilterType.lowpass, freq: 260, dur: 0.035, gain: 1.6);
    }
  },
  // The voice call connects: two notes up, like a phone picked up.
  'voiceOn': (pen) {
    pen.bell(freq: 659, dur: 0.35, gain: 0.19);
    pen.bell(at: 0.12, freq: 988, dur: 0.5, gain: 0.19);
  },
  // The farm phone rings: an old desk phone's double trill, twice.
  'ring': (pen) {
    for (final at in [0.0, 0.42]) {
      for (var i = 0; i < 8; i++) {
        pen.bell(at: at + i * 0.04, freq: i.isOdd ? 1320 : 1480, dur: 0.05, gain: 0.07);
      }
    }
  },
  // …and hangs up: the same two notes down.
  'voiceOff': (pen) {
    pen.bell(freq: 988, dur: 0.3, gain: 0.19);
    pen.bell(at: 0.12, freq: 587, dur: 0.45, gain: 0.19);
  },
};

/// Every sound by where it is heard: the debug console and the asset browser list them so.
const soundGroups = <({String title, List<String> names})>[
  (title: '界面', names: ['tap', 'nope', 'pick', 'open', 'close']),
  (title: '农具', names: ['water', 'spray', 'weed', 'harvest', 'shovel']),
  (title: '地里', names: ['plant', 'arrive', 'ripe', 'bug']),
  (title: '院子', names: ['rustle', 'splash', 'thud', 'woof', 'yip', 'pant', 'meow', 'mew', 'purr']),
  (title: '奖励', names: ['coin', 'levelUp', 'achievement']),
  (title: '语音', names: ['voiceOn', 'voiceOff', 'ring']),
];

/// Labels for the debug console and the asset browser.
const soundLabel = <String, String>{
  'tap': '点击',
  'nope': '点不了',
  'pick': '拿工具',
  'open': '展开',
  'close': '收起',
  'water': '浇水',
  'spray': '杀虫',
  'weed': '除草',
  'harvest': '收获',
  'shovel': '铲除',
  'plant': '播种',
  'ripe': '熟了',
  'bug': '长虫',
  'coin': '金币',
  'levelUp': '升级',
  'achievement': '成就',
  'arrive': '帮工到了',
  'rustle': '草叶沙沙',
  'splash': '扑通',
  'thud': '踩土',
  'woof': '小狗叫',
  'meow': '小猫叫',
  'mew': '小猫短叫',
  'purr': '小猫呼噜',
  'yip': '小狗跳',
  'pant': '小狗喘气',
  'voiceOn': '语音接通',
  'voiceOff': '语音挂断',
  'ring': '来电',
};

/// A sound rendered offline, as the web page's renderSound: for the level check and for saving as WAV.
Float32List renderSound(String name) => renderRecipe(sounds[name]!, seconds: 2, volume: 0.55);

/// Where the WAV goes to be heard. The default plays it with audioplayers; tests put a fake in.
abstract class SfxOutput {
  Future<void> play(String name, Uint8List wav);
}

/// Plays each sound from a WAV file in the temp directory, a player per sound so they can overlap.
class PlayerOutput implements SfxOutput {
  final _files = <String, String>{};
  final _dir = Directory('${Directory.systemTemp.path}/vibevalley-sfx');

  @override
  Future<void> play(String name, Uint8List wav) async {
    final path = _files[name] ??= await () async {
      await _dir.create(recursive: true);
      final file = File('${_dir.path}/$name-${wav.length}.wav');
      await file.writeAsBytes(wav, flush: true);
      return file.path;
    }();
    final player = AudioPlayer();
    await player.setReleaseMode(ReleaseMode.release);
    player.onPlayerComplete.first.then((_) => player.dispose());
    await player.play(DeviceFileSource(path), mode: PlayerMode.lowLatency);
  }
}

/// How many takes of each sound are kept: plays cycle through them, so a repeated sound keeps a little life (the
/// page renders each play with a new seed; this renders a few once and reuses them).
const _takes = 3;

/// The sound effects by name ('tap', 'coin', 'harvest', 'levelUp'…), as the web page's sfx.
abstract final class Sfx {
  static SfxOutput? _output;
  static bool _muted = false;
  static int _plays = 0;
  static final _wavs = <String, Future<Uint8List>>{};
  static final _played = <({String name, DateTime at})>[];

  /// Where sounds go; set to a fake in tests. Until set, the first play makes the audioplayers one.
  static set output(SfxOutput? output) => _output = output;

  static bool get muted => _muted;
  static void setMuted(bool muted) => _muted = muted;

  /// The last sounds that actually played, oldest first.
  static List<({String name, DateTime at})> played() => List.unmodifiable(_played);

  /// Plays a sound now, unless muted or unknown.
  static void play(String name) {
    if (_muted || !sounds.containsKey(name)) return;
    final take = _plays++ % _takes;
    _played.add((name: name, at: DateTime.now()));
    if (_played.length > 30) _played.removeAt(0);
    final key = '$name-$take';
    final wav = _wavs[key] ??= _render(name, take);
    unawaited(
      wav.then((bytes) => (_output ??= PlayerOutput()).play(key, bytes)).catchError((Object e) {
        // No audio device, or the plugin is missing (tests): the farm goes on silently.
        debugPrint('vibevalley: sound $name did not play: $e');
      }),
    );
  }

  /// Renders every sound's first take ahead, off the UI thread, so the first plays are not late.
  static Future<void> warm() async {
    for (final name in sounds.keys) {
      await (_wavs['$name-0'] ??= _render(name, 0));
    }
  }

  /// How a take becomes a WAV: rendered off the UI thread. Tests put a stub in.
  static Future<Uint8List> Function(String name, int take) render = (name, take) => Isolate.run(() => wavOf(name, take));

  static Future<Uint8List> _render(String name, int take) => render(name, take);
}

/// A take of a sound as the page plays it live: its own seed, the limiter settled, cut after the last audible sample.
Uint8List wavOf(String name, int take) {
  final recipe = sounds[name]!;
  final seconds = recipeSeconds(recipe) + 0.3;
  return toWav(renderRecipe(recipe, seconds: seconds < 2 ? seconds : 2, seed: (take + 1) * 2654435761, settled: true));
}
