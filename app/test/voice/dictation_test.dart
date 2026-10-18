import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vibevalley/data/voice.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';
import 'package:vibevalley/chat/dictation_button.dart';
import 'package:vibevalley/voice/dictation.dart';

import '../support/server.dart';

class Recorder extends Fake implements AudioRecorder {
  Recorder({this.allowed = true});
  final bool allowed;
  String? path;
  RecordConfig? config;
  int starts = 0;
  int cancellations = 0;
  int disposals = 0;

  @override
  Future<bool> hasPermission({bool request = true}) async => allowed;

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    starts++;
    this.config = config;
    this.path = path;
    File(path).writeAsBytesSync(utf8.encode('RIFF-fake-wave'));
  }

  @override
  Future<String?> stop() async => path;

  @override
  Future<void> cancel() async {
    cancellations++;
  }

  @override
  Future<void> dispose() async {
    disposals++;
  }
}

class PendingPermission extends Recorder {
  final permission = Completer<bool>();
  @override
  Future<bool> hasPermission({bool request = true}) => permission.future;
}

class PendingStart extends Recorder {
  final entered = Completer<void>();
  final allowedToStart = Completer<void>();
  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    entered.complete();
    await allowedToStart.future;
    await super.start(config, path: path);
  }
}

void main() {
  test('one stretch is recorded, sent whole, and its words come back; the recording is not kept', () async {
    final server = FakeServer((r) async => jsonResponse({'text': '让阿郑改一下 refreshSession'}));
    final recorder = Recorder();
    final dictation = Dictation(server.api, recorder: () => recorder);
    final said = <String>[];
    final target = DictationTarget(said.add);
    await dictation.toggle(target);
    expect(dictation.phase, DictationPhase.recording);
    expect(recorder.config?.sampleRate, 16000);
    expect(recorder.config?.numChannels, 1);
    expect(server.requests, isEmpty, reason: 'nothing leaves while recording');
    await dictation.toggle(target);
    expect(said, ['让阿郑改一下 refreshSession']);
    expect(dictation.phase, DictationPhase.idle);
    final request = server.requests.single;
    expect(request.url.path, '/api/v1/voice/dictate');
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    expect(utf8.decode(base64Decode(body['audio'] as String)), 'RIFF-fake-wave');
    expect(body['format'], 'wav');
    await pumpEventQueue();
    expect(File(recorder.path!).existsSync(), isFalse);
    dictation.dispose();
  });

  test("the server's reason stays for the button, and nothing is inserted", () async {
    final server = FakeServer((r) async => http.Response(jsonEncode({'_tag': 'VoiceUnavailable', 'reason': '听写还没配：在「声音」页的「听写」里填地址和模型'}), 503));
    final dictation = Dictation(server.api, recorder: Recorder.new);
    final said = <String>[];
    final target = DictationTarget(said.add);
    await dictation.toggle(target);
    await dictation.toggle(target);
    expect(said, isEmpty);
    expect(dictation.problem, contains('听写还没配'));
    final denied = Dictation(server.api, recorder: () => Recorder(allowed: false));
    await denied.toggle(DictationTarget((_) {}));
    expect(denied.phase, DictationPhase.idle);
    expect(denied.problem, '录不了音：没有麦克风权限');
    dictation.dispose();
    denied.dispose();
  });

  test('the attempt keeps the input target that started it', () async {
    final server = FakeServer((r) async => jsonResponse({'text': 'first field'}));
    final a = <String>[], b = <String>[];
    final dictation = Dictation(server.api, recorder: Recorder.new);
    final first = DictationTarget(a.add), second = DictationTarget(b.add);
    await dictation.toggle(first);
    await dictation.toggle(second);
    expect(a, ['first field']);
    expect(b, isEmpty);
    dictation.dispose();
    first.dispose();
    second.dispose();
  });

  test('disposing the input target cancels pending permission before recording starts', () async {
    final recorder = PendingPermission();
    final server = FakeServer();
    final dictation = Dictation(server.api, recorder: () => recorder);
    final target = DictationTarget((_) => fail('cancelled target received words'));
    final starting = dictation.toggle(target);
    target.dispose();
    recorder.permission.complete(true);
    await starting;
    await pumpEventQueue();
    expect(recorder.starts, 0);
    expect(recorder.disposals, 1);
    expect(dictation.phase, DictationPhase.idle);
    expect(server.requests, isEmpty);
    dictation.dispose();
  });

  test('cancellation waits for pending recorder start and removes its late file', () async {
    final recorder = PendingStart();
    final dictation = Dictation(FakeServer().api, recorder: () => recorder);
    final target = DictationTarget((_) => fail('cancelled target received words'));
    final starting = dictation.toggle(target);
    await recorder.entered.future;
    target.dispose();
    recorder.allowedToStart.complete();
    await starting;
    await pumpEventQueue();
    expect(recorder.disposals, 1);
    expect(File(recorder.path!).existsSync(), isFalse);
    expect(dictation.phase, DictationPhase.idle);
    dictation.dispose();
  });

  test('a disposed target does not wait for transcription or receive its late result', () async {
    final entered = Completer<void>(), reply = Completer<void>();
    final server = FakeServer((r) async {
      entered.complete();
      await reply.future;
      return jsonResponse({'text': 'late'});
    });
    final recorder = Recorder();
    final dictation = Dictation(server.api, recorder: () => recorder);
    final words = <String>[];
    final target = DictationTarget(words.add);
    await dictation.toggle(target);
    final finishing = dictation.toggle(target);
    await entered.future;
    target.dispose();
    await finishing.timeout(const Duration(seconds: 1));
    expect(words, isEmpty);
    expect(File(recorder.path!).existsSync(), isFalse);
    reply.complete();
    await pumpEventQueue();
    expect(words, isEmpty);
    expect(recorder.disposals, 1);
    dictation.dispose();
  });

  testWidgets('removing an input button cancels its attempt without updating providers during disposal', (tester) async {
    final recorder = PendingPermission();
    final dictation = Dictation(FakeServer().api, recorder: () => recorder);
    final controller = TextEditingController();
    final showing = ValueNotifier(true);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [dictationProvider.overrideWith((ref) => dictation)],
        child: MaterialApp(
          home: Scaffold(
            body: ValueListenableBuilder(
              valueListenable: showing,
              builder: (_, visible, _) => visible ? DictationButton(controller: controller) : const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byType(DictationButton));
    await tester.pump();
    showing.value = false;
    await tester.pump();
    controller.dispose();
    recorder.permission.complete(true);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(recorder.starts, 0);
    expect(recorder.disposals, 1);
    expect(dictation.phase, DictationPhase.idle);
    showing.dispose();
  });

  test('dictated words go in at the cursor, with a space only between Latin words', () {
    final text = TextEditingController(text: '帮我看看')..selection = const TextSelection.collapsed(offset: 2);
    insertDictated(text, '前端');
    expect(text.text, '帮我前端看看');
    expect(text.selection.baseOffset, 4);
    final latin = TextEditingController(text: 'run');
    insertDictated(latin, 'tests');
    expect(latin.text, 'run tests');
    final mixed = TextEditingController(text: 'fix');
    insertDictated(mixed, '登录页');
    expect(mixed.text, 'fix登录页');
  });
}
