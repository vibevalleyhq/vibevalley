import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/data/prefs.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/voice.dart';
import 'package:vibevalley/voice/voice.dart';

import '../support/server.dart';

void main() {
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('the farm scope cancels its pending call and owns the current agent pick', () async {
    final pending = Completer<void>();
    final entered = Completer<void>();
    final server = FakeServer((r) async {
      entered.complete();
      await pending.future;
      return jsonResponse({'appId': 'test', 'channel': 'test', 'uid': '1', 'token': 'test'});
    });
    final container = ProviderContainer(overrides: [serverProvider.overrideWithValue(server)]);
    final call = container.read(voiceCallProvider);
    expect(call.agentPick!(), isNull);
    container.read(prefsProvider.notifier).setPick('chosen');
    expect(call.agentPick!(), 'chosen');
    final starting = call.start();
    await entered.future;
    container.dispose();
    await starting.timeout(const Duration(seconds: 1));
    await call.end();
    expect(call.phase, CallPhase.idle);
    pending.complete();
  });
}
