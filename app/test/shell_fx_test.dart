import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/shell/achievements.dart';
import 'package:vibevalley/shell/fx_layer.dart';
import 'package:vibevalley/shell/server_away.dart';
import 'package:vibevalley/ui/kit/kit.dart';

import 'support/shell.dart';
import 'package:vibevalley/rules/progress.dart';

void main() {
  group('ServerAway', () {
    Future<void> show(WidgetTester tester, {required bool reachable}) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: shellOverrides(FakeServer(), reachable: reachable),
          child: const MaterialApp(home: Scaffold(body: ServerAway())),
        ),
      );
      await tester.pump();
    }

    testWidgets('says the server is away, and how to start it', (tester) async {
      await show(tester, reachable: false);
      expect(find.textContaining('连不上 VibeValley 服务端。', findRichText: true), findsOneWidget);
      expect(find.textContaining('cd server && go run ./cmd/server', findRichText: true), findsOneWidget);
      expect(find.textContaining('连上后这里会自己好', findRichText: true), findsOneWidget);
    });

    testWidgets('says nothing while the server answers', (tester) async {
      await show(tester, reachable: true);
      expect(find.textContaining('连不上', findRichText: true), findsNothing);
    });
  });

  group('FxLayer', () {
    late StreamController<GameEffect> effects;
    late StreamController<SideEvent> notices;
    late ToastManager manager;

    setUp(() {
      effects = StreamController<GameEffect>.broadcast();
      notices = StreamController<SideEvent>.broadcast();
      manager = ToastManager();
    });

    Future<void> show(WidgetTester tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: shellOverrides(FakeServer()),
          child: MaterialApp(
            home: Scaffold(
              body: FxLayer(effects: effects.stream, notices: notices.stream, manager: manager),
            ),
          ),
        ),
      );
    }

    testWidgets('a level-up shows the banner, says a new bed opened at Lv.5, and goes after 3.4 s', (tester) async {
      await show(tester);
      effects.add(const GameEffectLevelUp(level: 5));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('LEVEL UP'), findsOneWidget);
      expect(find.text('农场 Lv.5'), findsOneWidget);
      expect(find.text('开垦了一块新地'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 3100));
      expect(find.text('农场 Lv.5'), findsNothing);

      effects.add(const GameEffectLevelUp(level: 3));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('农场 Lv.3'), findsOneWidget);
      expect(find.text('开垦了一块新地'), findsNothing);
      await tester.pump(const Duration(seconds: 4));
    });

    testWidgets('an achievement becomes a toast: its tier\'s title, what it was for, its coins, its medal line', (tester) async {
      await show(tester);
      effects.add(const GameEffectAchievement(achievement: 'harvests', tier: 2));
      effects.add(const GameEffectAchievement(achievement: 's_open', tier: 1));
      effects.add(const GameEffectAchievement(achievement: 'no_such', tier: 1));
      effects.add(const GameEffectReward(sessionId: 'w1', coins: 30, streak: 1));
      await tester.pump();
      final list = manager.toasts;
      expect(list.map((t) => t.title), ['开门', '小有收成']);
      expect(list.last.description, '收进主分支的活 · +30 金币');
      expect(list.first.description, '开工 · +20 金币');
      expect(list.last.type, ToastType.achievement);
      expect(toastKicker(list.last), '升到银牌');
      expect(toastKicker(list.first), '新手任务做完了');
      manager.dispose();
    });

    testWidgets('notices become toasts titled by their level', (tester) async {
      await show(tester);
      notices.add(SideEventNotice(at: 0, level: NoticeLevel.fromJson('warn'), text: '地里种满了'));
      notices.add(SideEventNotice(at: 0, level: NoticeLevel.fromJson('error'), text: '模型调用失败'));
      await tester.pump();
      expect(manager.toasts.map((t) => (t.type, t.title, t.description)), [('error', '出错了', '模型调用失败'), ('warn', '没派成', '地里种满了')]);
      expect(manager.toasts.first.timeout, const Duration(milliseconds: 7000));
      expect(manager.toasts.last.timeout, const Duration(milliseconds: 4500));
      manager.dispose();
    });
  });

  test('the achievement rules are the protocol\'s', () {
    final harvests = achievementOf('harvests')!;
    expect(tierTitle(harvests, 1), '开张大吉');
    expect(tierTitle(achievementOf('steady')!, 3), '金牌稳如老农');
    expect(tierCoins(harvests, 3), 60);
    expect(tierCoins(achievementOf('night_owl')!, 1), 50);
    expect(earnedText(achievementOf('weekend')!, 1), '发现一个彩蛋');
  });
}
