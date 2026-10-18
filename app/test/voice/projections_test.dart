import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/chat/chat_state.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/voice.dart';
import 'package:vibevalley/phone/calls.dart';
import 'package:vibevalley/phone/phone.dart';
import 'package:vibevalley/voice/voice.dart';

import '../support/server.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('phone owner records a call without phone widgets reporting its phases', () async {
    final call = VoiceCall(FakeServer().api);
    final c = ProviderContainer(overrides: [voiceCallProvider.overrideWith((ref) => call), inboxProvider.overrideWithValue(const [])]);
    addTearDown(c.dispose);
    final one = c.listen(phoneProvider, (_, _) {});
    final two = c.listen(phoneProvider, (_, _) {});
    call.phase = CallPhase.live;
    call.notifyListeners();
    await c.pump();
    expect(c.read(phoneOpenProvider), isTrue);
    call.phase = CallPhase.idle;
    call.notifyListeners();
    await c.pump();
    expect(c.read(phoneProvider).log.whereType<PhoneLogVoice>(), hasLength(1));
    expect(c.read(phoneOpenProvider), isFalse);
    one.close();
    two.close();
  });
  test('phone call history keeps following while its views are paused', () async {
    final call = VoiceCall(FakeServer().api);
    final c = ProviderContainer(overrides: [voiceCallProvider.overrideWith((ref) => call), inboxProvider.overrideWithValue(const [])]);
    addTearDown(c.dispose);
    final view = c.listen(phoneProvider, (_, _) {});
    await c.pump();
    view.close();
    await c.pump();
    call.phase = CallPhase.live;
    call.notifyListeners();
    await c.pump();
    call.phase = CallPhase.idle;
    call.notifyListeners();
    await c.pump();
    expect(c.read(phoneProvider).log.whereType<PhoneLogVoice>(), hasLength(1));
  });

  test('caption projection updates with no farm chat window mounted', () async {
    final call = VoiceCall(FakeServer().api);
    call.captions.apply({'object': 'assistant.transcription', 'turn_id': 1, 'text': 'first', 'turn_status': 0});
    final c = ProviderContainer(overrides: [voiceCallProvider.overrideWith((ref) => call)]);
    addTearDown(c.dispose);
    final sub = c.listen(spokenProvider, (_, _) {});
    expect(c.read(spokenProvider).single.text, 'first');
    call.captions.apply({'object': 'assistant.transcription', 'turn_id': 1, 'text': 'updated', 'turn_status': 0});
    call.notifyListeners();
    await c.pump();
    expect(c.read(spokenProvider).single.text, 'updated');
    sub.close();
  });
}
