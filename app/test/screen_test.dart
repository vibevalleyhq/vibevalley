import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/desktop/desktop.dart';
import 'package:vibevalley/game/farm.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/farm/farm_page.dart';
import 'package:vibevalley/shell/title/title_state.dart';
import 'package:vibevalley/data/remote.dart';

ChatMessage _said(int seq, SenderKind kind, String from, String name, String text) => ChatMessage(
  seq: seq.toDouble(),
  conversation: 1,
  from: from,
  fromKind: kind,
  name: name,
  kind: MessageKind.chat,
  text: text,
  final_: true,
  at: seq.toDouble(),
);

void main() {
  testWidgets('the farm screen', (tester) async {
    await tester.runAsync(() async {
      final font = FontLoader(pixelFont)
        ..addFont(Future.value(ByteData.sublistView(File('assets/fonts/fusion-pixel-12px-proportional-zh_hans.otf').readAsBytesSync())));
      await font.load();
    });
    final state = CoreState(
      call: CallState.live,
      manager: ManagerState.listening,
      workers: const [],
      progress: const Progress(coins: 20, streak: 0, bestStreak: 0, counts: {}, unlocked: []),
      chat: Chat(
        conversations: const [Conversation(id: 1, kind: ConversationKind.general, name: '田头', replies: 0, at: 0)],
        messages: [
          _said(1, SenderKind.manager, 'manager', '管家', '农场开门了，今天种点什么？'),
          _said(2, SenderKind.user, 'user', '主人', '让 antigravity 给农场加个夜间模式'),
          _said(3, SenderKind.manager, 'manager', '管家', '还没有用 Antigravity 的 agent，先去 Agent 页面建一个。'),
        ],
      ),
    );
    const view = FarmView(level: FarmLevel(level: 1, xp: 0, need: 10), plots: {});
    final frame = ReceivedFrame(StateFrame(state: state, inbox: const [], plans: const [], view: view, effects: const []), bytes: 0, decodeMicros: 0);
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    final key = GlobalKey();
    await tester.runAsync(() async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            stateFrameProvider.overrideWith((ref) => Stream.value(frame)),
            agentsProvider.overrideWithValue(AsyncData(const <String, Agent>{})),
            streamProblemProvider.overrideWith((ref) => const Stream<String>.empty()),
            sideEventsProvider.overrideWith((ref) => const Stream<SideEvent>.empty()),
            farmEffectsProvider.overrideWithValue(const Stream<GameEffect>.empty()),
            desktopProvider.overrideWithValue(Desktop.none),
            runtimesProvider.overrideWithValue(
              AsyncData([
                RuntimeInfo(
                  id: 'claude',
                  installation: const InstallationAvailable(via: Via.executable, command: 'claude'),
                  usage: const AccountUsageOk(windows: [UsageWindow(label: '5 小时', usedPercent: 61)]),
                  settings: RuntimeSettings.fromJson(const {
                    'enabled': true,
                    'binPath': '',
                    'defaultModel': '',
                    'defaultEffort': '',
                    'env': <String, String>{},
                  }),
                  checkedAt: 0,
                ),
              ]),
            ),
          ],
          child: RepaintBoundary(
            key: key,
            child: MaterialApp(theme: farmTheme(), debugShowCheckedModeBanner: false, home: const FarmPage()),
          ),
        ),
      );
      // The atlas, the level, every drawing: real time.
      for (var i = 0; i < 120; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump(const Duration(milliseconds: 50));
      }
      // Images inside cards decode in real time too.
      for (final e in find.byType(Image).evaluate()) {
        await precacheImage((e.widget as Image).image, e);
      }
      await tester.pump(const Duration(milliseconds: 50));
      final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage();
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory('build').createSync(recursive: true);
      File('build/screen.png').writeAsBytesSync(png!.buffer.asUint8List());
    });

    final container = ProviderScope.containerOf(tester.element(find.byType(FarmPage)));
    container.read(titleOpenProvider.notifier).enterFarm(start: false);
    await tester.pump();
    await tester.tap(find.bySemanticsLabel(RegExp('^杀虫：')));
    await tester.pump();
    expect(container.read(heldToolProvider), Tool.bug);
    await tester.sendKeyEvent(LogicalKeyboardKey.digit5);
    expect(container.read(heldToolProvider), Tool.harvest);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(container.read(heldToolProvider), Tool.hand);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(container.read(menuOpenProvider), isTrue);
    expect(find.text('院子里能点的'), findsOneWidget);
    container.read(menuOpenProvider.notifier).set(false);
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('任务与成就'));
    await tester.pump();
    expect(container.read(panelProvider), FarmPanel.tasks);
    container.read(panelProvider.notifier).set(null);
    await tester.pumpWidget(const SizedBox());
  });
}
