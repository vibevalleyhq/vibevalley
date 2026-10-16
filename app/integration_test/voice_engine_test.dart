// The voice-only Agora plugin (tool/agora-voice-only.sh) still starts an engine with audio on: the extensions it
// leaves out are weakly linked and never asked for. Runs on a real device or desktop, no network or Agora account:
//   flutter test integration_test -d macos

import 'package:agora_rtc_engine/agora_rtc_engine.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('an engine starts with audio, its noise suppression and echo cancellation, and releases', (_) async {
    final engine = createAgoraRtcEngine();
    // Any well-formed App ID: initializing does not ask Agora's servers.
    await engine.initialize(const RtcEngineContext(appId: '0123456789abcdef0123456789abcdef', channelProfile: ChannelProfileType.channelProfileCommunication));
    await engine.enableAudio();
    // The two extensions the voice-only plugin keeps.
    await engine.setAINSMode(enabled: true, mode: AudioAinsMode.ainsModeBalanced);
    await engine.setAudioProfile(profile: AudioProfileType.audioProfileDefault, scenario: AudioScenarioType.audioScenarioAiClient);
    await engine.muteLocalAudioStream(true);
    expect(await engine.getVersion(), isNotNull);
    await engine.release();
  });
}
