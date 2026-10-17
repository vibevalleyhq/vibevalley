import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/app/host_router.dart';
import 'package:vibevalley/data/ui_state.dart';
import 'package:vibevalley/host/desktop.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a host command opens the thing it names, and voice is left to the farm', () async {
    final commands = StreamController<HostCommand>.broadcast();
    final c = ProviderContainer(
      overrides: [
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
    expect(c.read(panelProvider), FarmPanel.tasks);

    commands.add(const HostOpenPlans('pb1'));
    await Future<void>.delayed(Duration.zero);
    expect(c.read(planShownProvider), 'pb1');
    expect(c.read(panelProvider), FarmPanel.plans);

    final before = c.read(selectedProvider);
    commands.add(const HostVoice());
    await Future<void>.delayed(Duration.zero);
    expect(c.read(selectedProvider), before);
  });
}
