import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/server.dart' show atlas;
import 'package:go_router/go_router.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/phone/blocks_game.dart';
import 'package:vibevalley/phone/calls.dart';
import 'package:vibevalley/phone/phone.dart';
import 'package:vibevalley/phone/sokoban_game.dart';
import 'package:vibevalley/voice/voice.dart';
import 'package:vibevalley/data/remote.dart';

class FakeInbox extends Notifier<List<InboxItem>> {
  @override
  List<InboxItem> build() => const [];
  void calls(List<InboxItem> calls) => state = calls;
}

final fakeInbox = NotifierProvider<FakeInbox, List<InboxItem>>(FakeInbox.new);

const ripe = InboxItem(
  id: 'w1:merge:2',
  kind: InboxKind.merge,
  from: InboxFromSession(id: 'w1', name: '阿郑', agent: 'zheng'),
  text: '修好了登录页',
  at: 30,
  target: InboxTargetSession(id: 'w1'),
);
const failed = InboxItem(
  id: 'w2:fix:1',
  kind: InboxKind.fix,
  from: InboxFromSession(id: 'w2', name: '阿周', agent: 'zhou'),
  text: '测试没过',
  at: 20,
  target: InboxTargetSession(id: 'w2'),
);
const draft = InboxItem(
  id: 'pb1:draft',
  kind: InboxKind.planDraft,
  from: InboxFromManager(),
  text: '登录改版',
  at: 40,
  target: InboxTargetPlans(playbook: 'pb1'),
);
const mention = InboxItem(
  id: 'm4',
  kind: InboxKind.mention,
  from: InboxFromManager(),
  text: '@主人 要不要收？',
  at: 50,
  target: InboxTargetChat(conversation: 'c3'),
);

class Corner extends ConsumerWidget {
  const Corner({super.key, required this.call});
  final VoiceCall call;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Align(
    alignment: Alignment.bottomLeft,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (ref.watch(phoneOpenProvider)) FarmPhone(call: call),
        const SizedBox(height: 4),
        PhoneButton(call: call),
      ],
    ),
  );
}

void main() {
  late VoiceCall call;
  late ProviderContainer container;
  final targets = <PhoneTarget>[];
  final routes = <String>[];

  Future<void> farm(WidgetTester tester, {List<InboxItem> standing = const []}) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    call = VoiceCall(VibeValleyServer(Uri.parse('http://127.0.0.1:9')).api);
    container = ProviderContainer(
      overrides: [
        inboxProvider.overrideWith((ref) => ref.watch(fakeInbox)),
        atlasProvider.overrideWith((ref) async => atlas),
        agentsProvider.overrideWithValue(AsyncData(const <String, Agent>{})),
      ],
    );
    container.read(fakeInbox.notifier).calls(standing);
    targets.clear();
    routes.clear();
    container.listen(phoneTargetProvider, (_, t) => targets.add(t!));
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => Scaffold(body: Corner(call: call)),
        ),
        GoRoute(
          path: '/chat/:id',
          builder: (_, s) {
            routes.add(s.uri.path);
            return const Text('chat');
          },
        ),
      ],
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
  }

  Future<void> done(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    container.dispose();
    await tester.binding.setSurfaceSize(null);
  }

  testWidgets('what stands when the farm opens is missed, not ringing; a new call rings and opens the phone', (tester) async {
    await farm(tester, standing: [ripe]);
    expect(container.read(phoneOpenProvider), isFalse);
    expect(find.text('1'), findsOneWidget, reason: 'the button counts the missed call');
    container.read(fakeInbox.notifier).calls([failed, ripe]);
    await tester.pump();
    // The phone follows the view after the frame it changed in (calls.dart).
    await tester.pump();
    expect(container.read(phoneOpenProvider), isTrue);
    expect(find.text('来电…'), findsOneWidget);
    expect(find.text('阿周'), findsOneWidget);
    expect(find.text('活没做成'), findsOneWidget);
    expect(find.text('来电'), findsOneWidget, reason: 'the button says a call is coming in');
    await tester.tap(find.text('接听'));
    await tester.pump();
    expect(container.read(phoneOpenProvider), isFalse);
    expect(targets.single, isA<PhoneTargetSession>().having((t) => t.id, 'id', 'w2'));
    expect(container.read(phoneProvider).missed.map((c) => c.id), ['w1:merge:2']);
    expect(container.read(phoneProvider).log.single, isA<PhoneLogCall>().having((e) => e.answered, 'answered', true));
    await done(tester);
  });

  testWidgets('hung up, the call leaves the missed list and the phone goes back; a plan call opens the plans', (tester) async {
    await farm(tester);
    container.read(fakeInbox.notifier).calls([failed]);
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('挂断'));
    await tester.pump();
    expect(container.read(phoneOpenProvider), isFalse);
    expect(container.read(phoneProvider).missed, isEmpty);
    expect(targets, isEmpty);
    container.read(fakeInbox.notifier).calls([draft, failed]);
    await tester.pump();
    await tester.pump();
    expect(find.text('管家'), findsOneWidget);
    expect(find.text('计划拆好了'), findsOneWidget);
    await tester.tap(find.text('接听'));
    await tester.pump();
    expect(targets.single, isA<PhoneTargetPlans>().having((t) => t.playbook, 'playbook', 'pb1'));
    await done(tester);
  });

  testWidgets('a call left ringing for 20 s is missed, and answered from the list it opens the chat', (tester) async {
    await farm(tester);
    container.read(fakeInbox.notifier).calls([mention]);
    await tester.pump();
    await tester.pump();
    expect(find.text('来电…'), findsOneWidget);
    await tester.pump(ringFor);
    await tester.pump();
    expect(container.read(phoneOpenProvider), isFalse);
    expect(container.read(phoneProvider).missed.single.id, 'm4');
    await tester.tap(find.text('手机'));
    await tester.pump();
    expect(find.text('农场通'), findsOneWidget);
    await tester.tap(find.text('未接'));
    await tester.pump();
    expect(find.text('未接 1'), findsOneWidget);
    expect(find.text('@主人 要不要收？'), findsOneWidget);
    await tester.tap(find.text('@主人 要不要收？'));
    await tester.pumpAndSettle();
    expect(routes, ['/chat/c3']);
    await done(tester);
  });

  testWidgets('a call answered elsewhere stops ringing by itself', (tester) async {
    await farm(tester);
    container.read(fakeInbox.notifier).calls([ripe]);
    await tester.pump();
    await tester.pump();
    expect(find.text('来电…'), findsOneWidget);
    container.read(fakeInbox.notifier).calls([]);
    await tester.pump();
    await tester.pump();
    expect(container.read(phoneOpenProvider), isFalse);
    expect(container.read(phoneProvider).ringing, isNull);
    await done(tester);
  });

  testWidgets('方块 opens from the home screen, starts on A, takes the arrows, and pauses on B', (tester) async {
    await farm(tester);
    await tester.tap(find.text('手机'));
    await tester.pump();
    await tester.tap(find.text('方块'));
    await tester.pump();
    expect(find.text('按 A 开始'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyZ);
    await tester.pump();
    final started = container.read(blocksGameProvider)!;
    expect(find.text('按 A 开始'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(container.read(blocksGameProvider)!.piece.x, started.piece.x - 1);
    await tester.pump(const Duration(milliseconds: 850));
    await tester.pump(const Duration(milliseconds: 16));
    expect(container.read(blocksGameProvider)!.piece.y, greaterThan(0));
    await tester.tap(find.text('B'));
    await tester.pump();
    expect(find.text('按 A 继续'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('主屏'));
    await tester.pump();
    expect(find.text('小恐龙'), findsOneWidget);
    expect(container.read(blocksGameProvider), isNotNull);
    await done(tester);
  });

  testWidgets('推箱子: a push to the goal finishes the first warehouse, A moves on; Esc puts the phone away', (tester) async {
    await farm(tester);
    await tester.tap(find.text('手机'));
    await tester.pump();
    await tester.tap(find.text('推箱子'));
    await tester.pump();
    expect(find.text('第一箱种子'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    expect(find.text('这一仓收拾好了！'), findsOneWidget);
    expect(find.text('1 步 · 1 推'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    expect(container.read(warehouseProvider).level, 1);
    expect(find.text('绕到后面'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(container.read(phoneOpenProvider), isFalse);
    await done(tester);
  });

  testWidgets('小恐龙 runs on A until it hits something', (tester) async {
    await farm(tester);
    await tester.tap(find.text('手机'));
    await tester.pump();
    await tester.tap(find.text('小恐龙'));
    await tester.pump();
    expect(find.text('按 A 开始'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    expect(find.text('按 A 开始'), findsNothing);
    for (var i = 0; i < 1000 && find.text('按 A 再来').evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(find.text('按 A 再来'), findsOneWidget);
    await done(tester);
  });
}
