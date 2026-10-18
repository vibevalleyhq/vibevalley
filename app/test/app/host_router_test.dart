import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/app/host_router.dart';
import 'package:vibevalley/data/ui_state.dart';
import 'package:vibevalley/data/voice.dart';
import 'package:vibevalley/voice/voice.dart';
import '../support/server.dart';
import 'package:vibevalley/host/desktop.dart';

class CommandVoice extends VoiceCall {
  CommandVoice() : super(FakeServer().api);
  int toggles = 0;
  @override
  Future<void> toggle() async => toggles++;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('one host router dispatches navigation and voice commands', () async {
    final commands = StreamController<HostCommand>.broadcast();
    final voice = CommandVoice();
    final c = ProviderContainer(
      overrides: [
        voiceCallProvider.overrideWith((ref) => voice),
        hostProvider.overrideWithValue(
          Desktop(isDesktop: false, titleBarHeight: 0, title: '', voiceShortcut: '', nativeVoice: false, voiceDispatch: false, commands: commands.stream),
        ),
      ],
    );
    addTearDown(() async {
      await commands.close();
      c.dispose();
    });
    c.listen(hostCommandRouterProvider, (_, _) {});
    await Future<void>.delayed(Duration.zero);

    commands.add(const HostOpenSession('w1'));
    commands.add(const HostOpenAchievements());
    await Future<void>.delayed(Duration.zero);
    expect(c.read(selectedProvider), 'w1');
    expect(c.read(panelProvider), FarmPanel.graphs);

    commands.add(const HostOpenTaskBoard('pb1'));
    await Future<void>.delayed(Duration.zero);
    expect(c.read(graphShownProvider), 'pb1');
    expect(c.read(panelProvider), FarmPanel.taskBoard);

    final before = c.read(selectedProvider);
    commands.add(const HostVoice());
    await Future<void>.delayed(Duration.zero);
    expect(c.read(selectedProvider), before);
    expect(voice.toggles, 1);
  });
}
