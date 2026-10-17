import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
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

  @override
  Future<bool> hasPermission({bool request = true}) async => allowed;

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    this.config = config;
    this.path = path;
    File(path).writeAsBytesSync(utf8.encode('RIFF-fake-wave'));
  }

  @override
  Future<String?> stop() async => path;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}

void main() {
  test('one stretch is recorded, sent whole, and its words come back; the recording is not kept', () async {
    final server = FakeServer((r) async => jsonResponse({'text': '让阿郑改一下 refreshSession'}));
    final recorder = Recorder();
    final dictation = Dictation(server.api, recorder: () => recorder);
    final said = <String>[];
    await dictation.toggle(said.add);
    expect(dictation.phase, DictationPhase.recording);
    expect(recorder.config?.sampleRate, 16000);
    expect(recorder.config?.numChannels, 1);
    expect(server.requests, isEmpty, reason: 'nothing leaves while recording');
    await dictation.toggle(said.add);
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
    await dictation.toggle(said.add);
    await dictation.toggle(said.add);
    expect(said, isEmpty);
    expect(dictation.problem, contains('听写还没配'));
    final denied = Dictation(server.api, recorder: () => Recorder(allowed: false));
    await denied.start();
    expect(denied.phase, DictationPhase.idle);
    expect(denied.problem, '录不了音：没有麦克风权限');
    dictation.dispose();
    denied.dispose();
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
