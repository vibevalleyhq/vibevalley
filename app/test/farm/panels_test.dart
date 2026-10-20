import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/farm/panels.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/farm.dart';
import 'package:vibevalley/data/ui_state.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final working = session(
    'w1',
    name: '小吴',
    station: 0,
    project: 'clock-in',
    branch: 'vibevalley/w1',
    files: ['src/a.ts'],
    commands: ['pnpm test'],
    history: const [ActionStep(at: 0, action: SessionAction.readFile, label: 'src/b.ts', actionText: '读文件')],
  );
  final failed = session(
    'w2',
    name: '阿郑',
    agent: 'front',
    station: 1,
    phase: const PhaseFailed(),
    last: const LastRun(outcome: Outcome.failed, summary: '测试挂了', at: 0),
  );
  final harvested = Issue(
    id: 't9',
    number: 9,
    title: '给 README 补上怎么启动',
    project: 'clock-in',
    assignee: 'tester',
    priority: Priority.medium,
    createdAt: 900,
    sessions: const ['w9'],
    closedAt: DateTime.now().millisecondsSinceEpoch - 60000.0,
    closed: IssueClose.merged,
    status: IssueStatus.done,
    moves: [],
    acceptance: Acceptance.glance,
    findings: [],
    asks: [],
  );
  const chat = Chat(
    conversations: [
      Conversation(id: 'c1', kind: ConversationKind.general, name: '田头', replies: 1, at: 0),
      Conversation(
        id: 'c2',
        kind: ConversationKind.thread,
        parent: 'm1',
        parentNumber: 1,
        channel: 'c1',
        subjectKind: SubjectKind.issue,
        subjectId: 't9',
        replies: 1,
        at: 0,
      ),
    ],
    messages: [
      ChatMessage(
        id: 'm2',
        number: 2,
        conversation: 'c2',
        from: 'w9',
        fromKind: SenderKind.agent,
        name: '老李',
        agent: 'tester',
        kind: MessageKind.report,
        text: '补好了',
        final_: true,
        session: 'w9',
        outcome: Outcome.completed,
        at: 1000,
      ),
    ],
  );
  final state = farm(sessions: [working, failed], progress: progress, chat: chat, issues: [harvested]);
  final v = view(
    plots: {
      'tw1': const PlotView(crop: Crop.leafy),
      'tw2': const PlotView(
        crop: Crop.withered,
        badge: PlotViewBadge(text: '有虫', tone: BadgeTone.bug),
      ),
    },
  );
  final agents = {'tester': agent('tester', '测试小吴'), 'front': agent('front', '前端阿郑')};

  final tasks = [
    {'seq': 1, 'time': 0, 'type': 'user/message', 'text': '跑一遍测试'},
    {
      'seq': 2,
      'time': 10,
      'type': 'tool/call',
      'text': 'pnpm test',
      'action': 'run_command',
      'actionText': '跑命令',
      'tool': 'Bash',
      'input': '{"command":"pnpm test"}',
      'output': 'ok',
      'ok': true,
    },
  ];

  testWidgets('a bed: what it is doing, its project, its steps, and its buttons', (tester) async {
    final routes = Routes({
      'PUT /api/v1/issues/tw1/status': Issue(
        id: 'tw1',
        number: 1,
        title: working.brief,
        priority: Priority.medium,
        createdAt: 0,
        status: IssueStatus.canceled,
        sessions: ['w1'],
        moves: [],
        acceptance: Acceptance.glance,
        findings: [],
        asks: [],
      ).toJson(),
    });
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(state, v, fakeApi(routes, {'GET /api/v1/sessions/w1/events': tasks}), agents: agents),
    );
    c.read(farmOverlaysProvider.notifier).select('w1');
    await settle(tester);
    expect(find.text('小吴的地'), findsOneWidget);
    expect(find.text('clock-in'), findsOneWidget);
    expect(find.textContaining('正在改文件'), findsOneWidget, reason: 'what it is doing, in the frame\'s words, is the status');
    expect(find.text('干活过程'), findsOneWidget);
    expect(find.text('工单'), findsNothing, reason: '干活过程 starts folded');
    await tester.tap(find.text('干活过程'));
    await settle(tester);
    expect(find.text('工单'), findsOneWidget);
    expect(find.text('跑命令'), findsWidgets, reason: 'the call says its action as the server wrote it');
    expect(routes.paths, contains('GET /api/v1/sessions/w1/events'));
    await tester.ensureVisible(find.text('叫停这一轮'));
    await tester.tap(find.text('叫停这一轮'));
    await settle(tester);
    expect(routes.paths, contains('POST /api/v1/sessions/w1/stop'));
    await tester.enterText(find.byType(EditableText).first, '先别动测试');
    await tester.pump();
    await tester.ensureVisible(find.bySemanticsLabel('带话'));
    await tester.tap(find.bySemanticsLabel('带话'));
    await settle(tester);
    expect(routes.calls.last.path, '/api/v1/issues/tw1/comment');
    expect(routes.calls.last.body, {'text': '先别动测试', 'sendKey': isA<String>()});
    await tester.ensureVisible(find.text('关上'));
    await tester.tap(find.text('关上'));
    await settle(tester);
    expect(routes.paths, contains('PUT /api/v1/issues/tw1/status'));
    expect(c.read(selectedProvider), isNull);
    expect(find.text('小吴的地'), findsNothing);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('a failed bed: its last word, and 杀虫 to go on', (tester) async {
    final routes = Routes();
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(routes), agents: agents));
    c.read(farmOverlaysProvider.notifier).select('w2');
    await settle(tester);
    expect(find.text('测试挂了'), findsOneWidget);
    await tester.tap(find.text('接着修'));
    await settle(tester);
    expect(routes.calls.last.path, '/api/v1/issues/tw2/comment');
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('the watering can takes a drop of advice to the helper', (tester) async {
    final routes = Routes();
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(routes), agents: agents));
    c.read(farmOverlaysProvider.notifier).water('w1');
    await settle(tester);
    expect(find.text('给小吴浇水'), findsOneWidget);
    expect(find.text('它正在干活，这句话会在下一步之前收到。'), findsOneWidget);
    await tester.tap(find.text('顺便补个测试'));
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('浇水'));
    await settle(tester);
    expect(routes.calls.single.body, {'text': '顺便补个测试', 'sendKey': isA<String>()});
    expect(c.read(wateringProvider), isNull);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('the warehouse, the log and the shop', (tester) async {
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(Routes()), agents: agents));
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.warehouse);
    await settle(tester);
    expect(find.text('仓库'), findsOneWidget);
    expect(find.text('给 README 补上怎么启动'), findsOneWidget);
    expect(find.text('测试小吴 · clock-in · 1 分钟前收的'), findsOneWidget);
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.log);
    await settle(tester);
    expect(find.text('农场日志'), findsOneWidget);
    expect(find.text('做完'), findsOneWidget);
    expect(find.text('补好了'), findsOneWidget);
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.shop);
    await settle(tester);
    expect(find.text('商店还在装修，下一版开张。现在有 120 金币，先攒着。'), findsOneWidget);
    expect(find.text('稻草人'), findsOneWidget);
  });

  testWidgets('an empty warehouse and log say so', (tester) async {
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(farm(), view(), fakeApi(Routes())));
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.warehouse);
    await settle(tester);
    expect(find.text('仓库还空着。收获进主分支的活会放在这里。'), findsOneWidget);
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.log);
    await settle(tester);
    expect(find.text('还没有事。开工以后，你和管家说的话、谁做完了什么，都记在这里。'), findsOneWidget);
  });

  testWidgets('tasks and achievements: the level, the coins, the walls; a title to wear', (tester) async {
    // The achievements in words are game.achievements'; how far each is, the frame's view.
    final routes = Routes({
      'GET /api/v1/game/achievements': [for (final a in achievementList) a.toJson()],
    });
    final withStandings = view(plots: v.plots, achievements: standings);
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, withStandings, fakeApi(routes), agents: agents));
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.graphs);
    await settle(tester);
    expect(find.text('任务与成就'), findsOneWidget);
    expect(find.text('Lv.3'), findsOneWidget);
    expect(find.text('120'), findsOneWidget);
    expect(find.text('连胜 3 · 收成金币 ×1.2'), findsOneWidget);
    expect(find.textContaining('新手任务 1/2', findRichText: true), findsOneWidget);
    expect(find.textContaining('每做完一个 +20 金币', findRichText: true), findsOneWidget);
    expect(find.text('收成 1/2'), findsOneWidget);
    expect(find.text('开张大吉'), findsOneWidget, reason: 'the tier reached, by its name');
    expect(find.text('4/20 件'), findsOneWidget, reason: 'the count and what the next tier takes');
    expect(find.text('3/5 件'), findsOneWidget);
    expect(find.text('Lv.5 开垦一块地'), findsOneWidget);
    expect(find.text('还有 2 个彩蛋'), findsOneWidget);
    await tester.tap(find.text('挑一个'));
    await settle(tester);
    await tester.tap(find.text('开张大吉').first);
    await settle(tester);
    final chosen = routes.named('POST', '/api/v1/game/title');
    expect(chosen.single.body, {'achievement': 'harvests', 'tier': 1});
  });

  testWidgets('the game menu; Esc and the backdrop close a panel', (tester) async {
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(Routes()), agents: agents));
    c.read(farmOverlaysProvider.notifier).menu(true);
    await settle(tester);
    expect(find.text('继续'), findsOneWidget);
    expect(find.text('院子里能点的'), findsOneWidget);
    await tester.tap(find.text('继续'));
    await settle(tester);
    expect(c.read(menuOpenProvider), isFalse);
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.shop);
    await settle(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await settle(tester);
    expect(c.read(panelProvider), isNull);
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.shop);
    await settle(tester);
    await tester.tapAt(const Offset(10, 10));
    await settle(tester);
    expect(c.read(panelProvider), isNull);
  });

  testWidgets("the manager's looks and the pet", (tester) async {
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(Routes()), agents: agents));
    c.read(farmOverlaysProvider.notifier).panel(FarmPanel.manager);
    await settle(tester);
    expect(find.text('管家和宠物'), findsOneWidget);
    expect(find.text('青年农夫'), findsOneWidget);
    expect(find.text('宠物'), findsOneWidget);
    expect(find.text('蓝猫'), findsOneWidget);
  });
}
