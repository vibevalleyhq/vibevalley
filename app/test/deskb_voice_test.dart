import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/voice/voice_page.dart';
import 'package:vibevalley/desk/voice/voice_rules.dart';
import 'package:vibevalley/desk/voice/voice_samples.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'deskb_support.dart';

Map<String, dynamic> voiceJson({String area = 'US'}) => {
  'area': area,
  'language': 'zh-CN',
  'asr': {'vendor': 'ares'},
  'llm': {'vendor': 'agora', 'model': 'gpt-4.1-mini'},
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
  'deepseekApiKey': {'source': 'env', 'hint': '…ab12'},
  'agoraAppId': {'source': 'settings', 'value': '0123456789abcdef0123456789abcdef'},
  'agoraAppCertificate': {'source': 'settings', 'hint': '…cdef'},
  'voice': voice ?? voiceJson(),
  'voiceDefaults': voiceJson(),
  'asrKey': <String, Object>{},
  'llmKey': <String, Object>{},
  'ttsKey': <String, Object>{},
};

FakeBackend backend() {
  Map<String, dynamic>? saved;
  return FakeBackend({
    'GET /api/settings': (_) => settingsJson(voice: saved),
    'PUT /api/settings': (c) {
      final voice = (c.body! as Map)['voice'] as Map<String, dynamic>?;
      if (voice != null) saved = {...voiceJson(), ...voice};
      return settingsJson(voice: saved);
    },
  });
}

void main() {
  group('rules', () {
    final defaults = VoiceSettings.fromJson(voiceJson());

    test('voiceOverrides keeps only what differs', () {
      final changed = voiceWith(
        defaults,
        area: Area.cN,
        llm: const VoiceLlmDeepseek(model: 'deepseek-chat'),
      );
      expect(voiceOverrides(defaults, changed).toJson(), {
        'area': 'CN',
        'llm': {'vendor': 'deepseek', 'model': 'deepseek-chat'},
      });
      expect(voiceOverrides(defaults, defaults).toJson(), isEmpty);
    });

    test('voiceProblem', () {
      expect(voiceProblem(asOverrides(defaults)), isNull);
      expect(voiceProblem(const SettingsUpdateVoice(asr: VoiceAsrMicrosoft(region: ' '))), '微软识别要填区域，比如 eastasia');
      expect(
        voiceProblem(
          const SettingsUpdateVoice(
            llm: VoiceLlmOpenai(url: 'ftp://x', model: 'm'),
          ),
        ),
        startsWith('大模型的地址'),
      );
      expect(voiceProblem(const SettingsUpdateVoice(llm: VoiceLlmDeepseek(model: ''))), '大模型要填模型名');
      expect(voiceProblem(const SettingsUpdateVoice(persona: '  ')), '管家的人设不能空着');
      expect(voiceProblem(const SettingsUpdateVoice(silenceMs: 100)), '停顿多久算说完（毫秒）要在 200 到 2000 之间');
      expect(voiceProblem(const SettingsUpdateVoice(idleSeconds: 30.5)), isNotNull);
    });

    test('settingsProblem and keyHint', () {
      expect(settingsProblem(const SettingsUpdate(deepseekApiKey: 'sk-12345678')), isNull);
      expect(settingsProblem(const SettingsUpdate(deepseekApiKey: 'sk 1')), startsWith('DeepSeek'));
      expect(settingsProblem(const SettingsUpdate(agoraAppId: 'nope')), startsWith('Agora 的 App ID'));
      expect(settingsProblem(const SettingsUpdate(agoraAppId: '')), isNull);
      expect(settingsProblem(const SettingsUpdate(ttsKey: 'a b')), '语音服务的 key 里不该有空格');
      expect(keyHint('sk-abcdef3a9'), '…f3a9');
    });

    test('every offered MiniMax voice has its sample file', () {
      expect(sampleFile('Chinese (Mandarin)_Gentle_Youth'), 'Chinese__Mandarin__Gentle_Youth.mp3');
      expect(voiceSample('typed-by-hand'), isNull);
      expect(voiceSample('female-yujie'), 'voice-samples/female-yujie.mp3');
    });
  });

  testWidgets('the line: keys, listening and thinking; a change is saved as overrides', (t) async {
    final b = backend();
    await pumpPage(t, const VoiceSettingsPage(), b);
    expect(find.text('能接通'), findsOneWidget);
    expect(find.text('/home/me/.vibevalley/settings.json'), findsOneWidget);
    expect(find.text('在用 …cdef（存在设置里）'), findsOneWidget);
    expect(find.text('都存着。'), findsOneWidget);
    await t.tap(find.text('中国大陆'));
    await t.pump();
    expect(find.text('有没存的改动。'), findsOneWidget);
    await t.tap(find.text('保存'));
    await settle(t);
    expect(b.named('PUT', '/api/settings').single.body, {
      'voice': {'area': 'CN'},
    });
    expect(find.text('存好了，下一通电话就用上。'), findsOneWidget);
  });

  testWidgets('picking a vendor shows its fields, and a bad one cannot be saved', (t) async {
    await pumpPage(t, const VoiceSettingsPage(), backend());
    await t.tap(find.text('自己的接口'));
    await t.pump();
    expect(find.text('接口的 key'), findsOneWidget);
    await t.enterText(find.bySemanticsLabel('大模型地址').last, 'not a url');
    await t.pump();
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
    await pumpPage(t, const VoiceSettingsPage(), b);
    await t.tap(find.text('清掉').last);
    await t.pump();
    expect(find.text('存的时候清掉'), findsOneWidget);
    await t.tap(find.text('保存'));
    await settle(t);
    expect(b.named('PUT', '/api/settings').single.body, {'agoraAppCertificate': ''});
  });

  testWidgets('the agent part: persona, greeting and the MiniMax voices with their samples', (t) async {
    final played = <String>[];
    Samples.play$ = (asset) async => played.add(asset);
    addTearDown(() => Samples.play$ = null);
    final b = backend();
    await pumpPage(t, const SingleChildScrollView(child: VoiceSettingsForm(part: VoicePart.agent)), b);
    expect(find.text('开口'), findsOneWidget);
    expect(find.text('温润青年'), findsOneWidget);
    await t.tap(find.bySemanticsLabel('试听 御姐'));
    await t.pump();
    expect(played, ['voice-samples/female-yujie.mp3']);
    await t.tap(find.text('御姐'));
    await t.pump();
    await t.tap(find.text('保存'));
    await settle(t);
    final voice = (b.named('PUT', '/api/settings').single.body! as Map)['voice'];
    expect(voice, {
      'tts': {'vendor': 'minimax', 'model': 'speech_2_6_turbo', 'voiceId': 'female-yujie'},
    });
  });
}
