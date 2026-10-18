import 'dart:async';
import 'dart:convert';

import 'package:agora_rtc_engine/agora_rtc_engine.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/voice/voice.dart';

import '../support/server.dart';

const session = {'appId': 'test-app', 'channel': 'test-channel', 'uid': '1', 'token': 'test-token'};

class Engine extends Fake implements RtcEngine {
  RtcEngineEventHandler? handler;
  int released = 0;
  bool failLeave = false;

  @override
  void registerEventHandler(RtcEngineEventHandler handler) => this.handler = handler;

  @override
  Future<void> leaveChannel({LeaveChannelOptions? options}) async {
    if (failLeave) throw StateError('leave failed');
  }

  @override
  Future<void> release({bool sync = false}) async => released++;

  @override
  dynamic noSuchMethod(Invocation invocation) => Future<void>.value();
}

void main() {
  setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.macOS);
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('captions wait for their agent id and stop at hangup', () async {
    final entered = Completer<void>(), ready = Completer<void>();
    final server = FakeServer((r) async {
      if (r.url.path == '/api/v1/voice/session') return jsonResponse(session);
      if (r.url.path == '/api/v1/voice/agent') {
        entered.complete();
        await ready.future;
        return jsonResponse({'agentId': 'call-1'});
      }
      return jsonResponse(null);
    });
    final call = VoiceCall(server.api, createEngine: Engine.new, agentPick: () => 'chosen');
    final starting = call.start();
    await entered.future;
    call.captions.onHeard!('hello');
    call.captions.onAnswered!('answer');
    expect(server.requests.where((r) => r.url.path.endsWith('/heard') || r.url.path.endsWith('/said')), isEmpty);
    ready.complete();
    await starting;
    await pumpEventQueue();
    final heard = server.requests.singleWhere((r) => r.url.path.endsWith('/heard'));
    final body = jsonDecode(heard.body) as Map<String, dynamic>;
    expect((body['sendKey'] as String).length, 32);
    expect(body..remove('sendKey'), {'agentId': 'call-1', 'text': 'hello', 'agent': 'chosen'});
    expect(jsonDecode(server.requests.singleWhere((r) => r.url.path.endsWith('/said')).body), {'agentId': 'call-1', 'text': 'answer'});
    await call.end();
    call.captions.onHeard!('late');
    await pumpEventQueue();
    expect(server.requests.where((r) => r.url.path.endsWith('/heard')).length, 1);
    call.dispose();
  });

  test('toggle from connecting hangs up without creating an engine', () async {
    final reply = Completer<void>();
    final entered = Completer<void>();
    final server = FakeServer((r) async {
      entered.complete();
      await reply.future;
      return jsonResponse(session);
    });
    final call = VoiceCall(server.api, createEngine: () => throw StateError('engine created after hangup'));
    final starting = call.toggle();
    await entered.future;
    final ending = call.toggle();
    reply.complete();
    await Future.wait([starting, ending]);
    expect(call.phase, CallPhase.idle);
    expect(call.problem, isNull);
    expect(server.requests.length, 1);
    call.dispose();
  });

  test('hangup does not wait for an unanswered session request', () async {
    final pending = Completer<void>();
    final entered = Completer<void>();
    final server = FakeServer((r) async {
      entered.complete();
      await pending.future;
      return jsonResponse(session);
    });
    final call = VoiceCall(server.api, createEngine: () => throw StateError('cancelled'));
    final starting = call.start();
    await entered.future;
    await call.end().timeout(const Duration(seconds: 1));
    await starting;
    expect(call.phase, CallPhase.idle);
    pending.complete();
    call.dispose();
  });

  test('a late voice agent is stopped once after disposal', () async {
    final pending = Completer<void>();
    final entered = Completer<void>();
    final engine = Engine();
    final server = FakeServer((r) async {
      switch (r.url.path) {
        case '/api/v1/voice/session':
          return jsonResponse(session);
        case '/api/v1/voice/agent':
          entered.complete();
          await pending.future;
          return jsonResponse({'agentId': 'late-agent'});
        default:
          return jsonResponse(null);
      }
    });
    final call = VoiceCall(server.api, createEngine: () => engine);
    final starting = call.start();
    await entered.future;
    call.dispose();
    final ending = call.end();
    await ending.timeout(const Duration(seconds: 1));
    pending.complete();
    await starting;
    await Future<void>.delayed(Duration.zero);
    expect(call.phase, CallPhase.idle);
    expect(engine.released, 1);
    expect(server.to('POST', '/api/v1/voice/agent/stop').length, 1);
    engine.handler!.onUserJoined?.call(const RtcConnection(), 7, 0);
    expect(call.agentHere, isFalse);
  });

  test('leaving failure still releases the engine and returns to idle', () async {
    final engine = Engine()..failLeave = true;
    final routes = Routes({
      'POST /api/v1/voice/session': session,
      'POST /api/v1/voice/agent': {'agentId': 'agent'},
    });
    final server = FakeServer(routes.handle);
    final call = VoiceCall(server.api, createEngine: () => engine);
    await call.start();
    expect(call.phase, CallPhase.live);
    await call.end();
    expect(engine.released, 1);
    expect(call.phase, CallPhase.idle);
    call.dispose();
  });
}
