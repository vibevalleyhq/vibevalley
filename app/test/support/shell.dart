import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/title/connection_banner.dart';
import 'package:vibevalley/audio/sfx.dart';
import 'server.dart';

export 'server.dart';

Map<String, dynamic> settingsJson({String? deepseek}) {
  const voice = {
    'area': 'CN',
    'language': 'zh-CN',
    'asr': {'vendor': 'ares'},
    'answer': {'vendor': 'manager'},
    'tts': {'vendor': 'microsoft', 'region': 'eastasia', 'voiceName': 'zh-CN-YunxiNeural'},
    'persona': '',
    'greeting': '',
    'failureMessage': '',
    'silenceMs': 500,
    'interruptMs': 300,
    'idleSeconds': 60,
  };
  return {
    'file': '/home/me/.vibevalley/settings.json',
    'deepseekApiKey': {'source': ?deepseek, if (deepseek != null) 'hint': 'sk-…abcd'},
    'agoraAppId': <String, dynamic>{},
    'agoraAppCertificate': <String, dynamic>{},
    'voice': voice,
    'voiceDefaults': voice,
    'asrKey': <String, dynamic>{},
    'llmKey': <String, dynamic>{},
    'ttsKey': <String, dynamic>{},
    'dictation': {'url': '', 'model': ''},
    'memorySources': <Object>[],
    'dictationKey': <String, dynamic>{},
  };
}

CoreState farmState({List<Map<String, dynamic>> sessions = const [], double coins = 0}) => CoreState.fromJson({
  'call': 'idle',
  'manager': 'idle',
  'sessions': sessions,
  if (coins > 0) 'progress': {'coins': coins, 'streak': 0, 'bestStreak': 0, 'counts': <String, Object>{}, 'unlocked': <Object>[]},
});

List<Override> shellOverrides(FakeServer server, {bool reachable = true}) {
  Sfx.render = (_, _) async => Uint8List(0);
  Sfx.setMuted(true);
  return [
    serverProvider.overrideWithValue(server),
    serverReachableProvider.overrideWith((ref) => Stream.value(reachable)),
    // The tests run on a Mac: not the desktop app all the same.
    hostProvider.overrideWithValue(Desktop.none),
  ];
}

/// Takes the tree down, so timers and tickers end with the test.
Future<void> unmount(WidgetTester tester) => tester.pumpWidget(const SizedBox());
