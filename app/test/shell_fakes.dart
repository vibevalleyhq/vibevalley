import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/desktop/desktop.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/shell/server_away.dart';
import 'package:vibevalley/shell/sfx.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class FakeServer extends VibeValleyServer {
  FakeServer([Future<http.Response> Function(http.Request)? handler])
    : _handler = handler ?? ((_) async => http.Response('{}', 200)),
      super(Uri.parse('http://farm.test'));

  final Future<http.Response> Function(http.Request) _handler;
  final requests = <http.Request>[];
  final frameFeed = StreamController<StateFrame>.broadcast();
  final sideFeed = StreamController<SiteEvent>.broadcast();

  late final VibeValleyApi _api = VibeValleyApi(
    base,
    MockClient((r) {
      requests.add(r);
      return _handler(r);
    }),
  );

  @override
  VibeValleyApi get api => _api;

  @override
  Stream<StateFrame> get frames => frameFeed.stream;

  @override
  Stream<SiteEvent> get sideEvents => sideFeed.stream;

  @override
  Future<bool> healthy() async => true;
}

Map<String, dynamic> settingsJson({String? deepseek}) {
  const voice = {
    'area': 'CN',
    'language': 'zh-CN',
    'asr': {'vendor': 'ares'},
    'llm': {'vendor': 'vibevalley'},
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
  };
}

http.Response json(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

FarmState farmState({List<Map<String, dynamic>> helpers = const [], double coins = 0}) => FarmState.fromJson({
  'call': 'idle',
  'foreman': 'idle',
  'helpers': helpers,
  if (coins > 0) 'progress': {'coins': coins, 'streak': 0, 'bestStreak': 0, 'counts': <String, Object>{}, 'unlocked': <Object>[]},
});

List<Override> shellOverrides(FakeServer server, {bool reachable = true}) {
  Sfx.render = (_, _) async => Uint8List(0);
  Sfx.setMuted(true);
  return [
    serverProvider.overrideWithValue(server),
    serverReachableProvider.overrideWith((ref) => Stream.value(reachable)),
    // The tests run on a Mac: not the desktop app all the same.
    desktopProvider.overrideWithValue(Desktop.none),
  ];
}

/// Takes the tree down, so timers and tickers end with the test.
Future<void> unmount(WidgetTester tester) => tester.pumpWidget(const SizedBox());
