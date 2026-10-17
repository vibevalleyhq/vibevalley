// Kept in the repository, so trying a voice needs no key, no call and no money.

import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import 'voice_rules.dart';

/// Anything but letters, digits, _ and - becomes _.
String sampleFile(String voiceId) => '${voiceId.replaceAll(RegExp(r'[^\w-]'), '_')}.mp3';

String? voiceSample(String voiceId) => minimaxVoices.any((v) => v.id == voiceId) ? 'voice-samples/${sampleFile(voiceId)}' : null;

abstract final class Samples {
  static AudioPlayer? _player;
  static VoidCallback? _ended;
  static StreamSubscription<void>? _done;

  /// null stops nothing and plays nothing.
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
