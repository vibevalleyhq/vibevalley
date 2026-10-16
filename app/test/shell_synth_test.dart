// The synth renders what the retired web page's did: test/fixtures/sfx.json holds a few sounds its synth.ts rendered
// from its sfx.ts recipes, and their levels by its measure.ts. The fixture is frozen: change it by hand with a sound.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/shell/sfx.dart';
import 'package:vibevalley/shell/synth.dart';

void main() {
  final fixture = jsonDecode(File('test/fixtures/sfx.json').readAsStringSync()) as Map<String, dynamic>;
  final expected = fixture['sounds'] as Map<String, dynamic>;

  for (final MapEntry(key: name, value: raw) in expected.entries) {
    test('$name: the same samples and levels as the web page', () {
      final want = raw as Map<String, dynamic>;
      final got = renderSound(name);
      expect(got.length, want['length']);
      final stride = want['stride'] as int;
      final samples = (want['samples'] as List).cast<num>();
      var worst = 0.0;
      for (var k = 0; k < samples.length; k++) {
        final d = (got[k * stride] - samples[k]).abs();
        if (d > worst) worst = d;
      }
      expect(worst, lessThan(2e-5), reason: 'largest difference from the web page');
      final m = measure(got);
      final wm = want['measure'] as Map<String, dynamic>;
      expect(m.peak, closeTo(wm['peak'] as num, 0.11));
      expect(m.loudness, closeTo(wm['loudness'] as num, 0.11));
      expect(m.seconds, closeTo(wm['seconds'] as num, 0.011));
    });
  }

  test('the seeded random is the page\'s xorshift', () {
    final r = seeded(1);
    // JavaScript: s = 1; s ^= s << 13; s ^= s >>> 17; s ^= s << 5 → 270369; 270369 % 10000 / 10000.
    expect(r(), 0.0369);
    final big = seeded(3 * 2654435761);
    expect(big(), inInclusiveRange(0, 1));
  });

  test('a live take is a WAV cut after its last sound', () {
    final wav = wavOf('coin', 0);
    expect(ascii.decode(wav.sublist(0, 4)), 'RIFF');
    expect(ascii.decode(wav.sublist(8, 12)), 'WAVE');
    final bytes = ByteData.sublistView(wav);
    expect(bytes.getUint32(24, Endian.little), 44100);
    final seconds = bytes.getUint32(40, Endian.little) / 2 / 44100;
    expect(seconds, inInclusiveRange(0.25, 0.5));
  });

  test('every sound renders, and every one has a label and a group', () {
    for (final name in sounds.keys) {
      expect(soundLabel[name], isNotNull, reason: name);
      expect(soundGroups.any((g) => g.names.contains(name)), isTrue, reason: name);
      expect(recipeSeconds(sounds[name]!), greaterThan(0), reason: name);
    }
  });
}
