import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/workbench/voice/voice_page.dart';
import 'package:vibevalley/workbench/voice/voice_samples.dart';

import '../support/workbench.dart';

Map<String, dynamic> voiceJson({String area = 'US'}) => {
  'area': area,
  'language': 'zh-CN',
  'asr': {'vendor': 'ares'},
  'answer': {'vendor': 'agora', 'model': 'gpt-4.1-mini'},
  'tts': {'vendor': 'minimax', 'model': 'speech_2_6_turbo', 'voiceId': 'Chinese (Mandarin)_Gentle_Youth'},
  'persona': '你是管家',
  'greeting': '来啦！今天想种点什么？',
  'failureMessage': '我这边卡了一下，你再说一遍？',
  'silenceMs': 480,
  'interruptMs': 160,
  'idleSeconds': 30,
};

Map<String, dynamic> settingsJson({Map<String, dynamic>? voice}) => {
  'file': '/home/me/.vibevalley/settings.json',
  'deepseekApiKey': {'source': 'config', 'hint': '…ab12'},
  'agoraAppId': {'source': 'settings', 'value': '0123456789abcdef0123456789abcdef'},
  'agoraAppCertificate': {'source': 'settings', 'hint': '…cdef'},
  'voice': voice ?? voiceJson(),
  'voiceDefaults': voiceJson(),
  'asrKey': <String, Object>{},
  'llmKey': <String, Object>{},
  'ttsKey': <String, Object>{},
  'dictation': {'url': '', 'model': ''},
  'dictationKey': <String, Object>{},
};

/// problem: what setting.check answers (the checks themselves are the Go's, tested there).
Routes backend({String? problem}) {
  Map<String, dynamic>? saved;
  return Routes({
    'GET /api/v1/settings': (_) => settingsJson(voice: saved),
    'POST /api/v1/settings/check': (_) => {'problem': ?problem},
    'PUT /api/v1/settings': (c) {
      final voice = (c.body! as Map)['voice'] as Map<String, dynamic>?;
      if (voice != null) saved = {...voiceJson(), ...voice};
      return settingsJson(voice: saved);
    },
  });
}

void main() {
  group('rules', () {
    test('every offered MiniMax voice has its sample file', () {
      expect(sampleFile('Chinese (Mandarin)_Gentle_Youth'), 'Chinese__Mandarin__Gentle_Youth.mp3');
      expect(voiceSample('typed-by-hand'), isNull);
      expect(voiceSample('female-yujie'), 'voice-samples/female-yujie.mp3');
    });
  });

  testWidgets('the line: keys, listening and thinking; a change is saved with the voice', (t) async {
    final b = backend();
    await pumpPage(t, const VoiceSettingsPage(), b.handle);
    expect(find.text('能接通'), findsOneWidget);
    expect(find.text('/home/me/.vibevalley/settings.json'), findsOneWidget);
    expect(find.text('在用 …cdef（存在设置里）'), findsOneWidget);
    expect(find.text('都存着。'), findsOneWidget);
    await t.tap(find.text('中国大陆'));
    await t.pump();
    expect(find.text('有没存的改动。'), findsOneWidget);
    await t.tap(find.text('保存'));
    await settle(t);
    // The voice goes whole; the server keeps what differs from its defaults.
    final put = b.named('PUT', '/api/v1/settings').single.body! as Map;
    expect(put.keys, ['voice']);
    expect((put['voice'] as Map)['area'], 'CN');
    expect(find.text('存好了，下一通电话就用上。'), findsOneWidget);
  });

  testWidgets('picking a vendor shows its fields, and a bad one cannot be saved', (t) async {
    await pumpPage(t, const VoiceSettingsPage(), backend(problem: '大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions').handle);
    await t.tap(find.text('自己的接口'));
    await t.pump();
    expect(find.text('接口的 key'), findsOneWidget);
    await t.enterText(find.bySemanticsLabel('大模型地址').last, 'not a url');
    // The server's answer to setting.check lands a moment later.
    await settle(t);
    expect(find.textContaining('大模型的地址要是 http(s) 开头的完整地址'), findsOneWidget);
    // Leave the field first: its suggestions float over the bar while it has focus.
    FocusManager.instance.primaryFocus?.unfocus();
    await t.pump();
    await t.tap(find.text('撤销'));
    await t.pump();
    expect(find.text('都存着。'), findsOneWidget);
  });

  testWidgets('清掉 a key in settings sends it empty', (t) async {
    final b = backend();
    await pumpPage(t, const VoiceSettingsPage(), b.handle);
    await t.tap(find.text('清掉').last);
    await t.pump();
    expect(find.text('存的时候清掉'), findsOneWidget);
    await t.tap(find.text('保存'));
    await settle(t);
    expect(b.named('PUT', '/api/v1/settings').single.body, {'agoraAppCertificate': ''});
  });

  testWidgets('the agent part: persona, greeting and the MiniMax voices with their samples', (t) async {
    final played = <String>[];
    Samples.play$ = (asset) async => played.add(asset);
    addTearDown(() => Samples.play$ = null);
    final b = backend();
    await pumpPage(t, const SingleChildScrollView(child: VoiceSettingsForm(part: VoicePart.agent)), b.handle);
    expect(find.text('开口'), findsOneWidget);
    expect(find.text('温润青年'), findsOneWidget);
    await t.tap(find.bySemanticsLabel('试听 御姐'));
    await t.pump();
    expect(played, ['voice-samples/female-yujie.mp3']);
    await t.tap(find.text('御姐'));
    await t.pump();
    await t.tap(find.text('保存'));
    await settle(t);
    final voice = (b.named('PUT', '/api/v1/settings').single.body! as Map)['voice'] as Map;
    expect(voice['tts'], {'vendor': 'minimax', 'model': 'speech_2_6_turbo', 'voiceId': 'female-yujie'});
  });
}
