// Short recordings of the MiniMax voices the voice settings offer, each saying the default greeting
// (web/src/voice/samples.ts): kept in the repository (web/src/voice/samples, bundled as assets/voice-samples/), so
// trying a voice needs no key, no call and no money. A voice id typed by hand has none. One plays at a time.

import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import 'voice_rules.dart';

/// The file a voice's sample is kept in: its id with anything but letters, digits, _ and - as _ (sample-file.ts).
String sampleFile(String voiceId) => '${voiceId.replaceAll(RegExp(r'[^\w-]'), '_')}.mp3';

/// The asset of a voice's sample (for audioplayers' AssetSource, under assets/); null when there is none.
String? voiceSample(String voiceId) => minimaxVoices.any((v) => v.id == voiceId) ? 'voice-samples/${sampleFile(voiceId)}' : null;

/// Plays a sample, stopping the one playing; `ended` is called when it stops, by itself or cut short.
abstract final class Samples {
  static AudioPlayer? _player;
  static VoidCallback? _ended;
  static StreamSubscription<void>? _done;

  /// Where sounds go: a fake in tests (null stops nothing and plays nothing).
  @visibleForTesting
  static Future<void> Function(String asset)? play$;

  static void stop() {
    final ended = _ended;
    _ended = null;
    unawaited(_done?.cancel());
    _done = null;
    unawaited(_player?.stop());
    ended?.call();
  }

  static void play(String asset, VoidCallback ended) {
    stop();
    _ended = ended;
    if (play$ case final fake?) {
      unawaited(fake(asset));
      return;
    }
    final player = _player ??= AudioPlayer();
    _done = player.onPlayerComplete.listen((_) => stop());
    unawaited(
      player.play(AssetSource(asset)).catchError((Object e) {
        debugPrint('vibevalley: sample $asset did not play: $e');
        stop();
      }),
    );
  }
}
