import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/farm/panels.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  PlaybookNode node(
    String id,
    String title, {
    List<String> needs = const [],
    List<String>? blockedBy,
    NodeState state = NodeState.waiting,
    String? conclusion,
  }) => PlaybookNode(id: id, title: title, task: '做$title', needs: needs, blockedBy: blockedBy, state: state, conclusion: conclusion, tries: 0);

  // What the server fills in (PlaybooksOf) is written out as it would.

  final draft = Playbook(
    id: 'p1',
    title: '按月查打卡',
    goal: '给 clock-in 加按月查询',
    project: 'clock-in',
    state: PlaybookState.draft,
    nodes: [
      node('api', '接口'),
      node('ui', '页面', needs: ['api'], blockedBy: ['api']),
      node('docs', '文档'),
    ],
    parallel: 2,
    createdAt: 0,
    layers: [
      ['api', 'docs'],
      ['ui'],
    ],
    asksForYou: true,
  );
  final ripe = Playbook(
    id: 'p2',
    title: '夜间模式',
    goal: '加夜间模式',
    project: 'farm',
    branch: 'vibevalley/p2',
    state: PlaybookState.ripe,
    nodes: [node('css', '样式', state: NodeState.merged, conclusion: '改好了')],
    parallel: 1,
    createdAt: 1,
    layers: [
      ['css'],
    ],
    asksForYou: true,
    settled: 1,
  );
  final changes = {
    'project': 'farm',
    'base': 'main',
    'branch': 'vibevalley/p2',
    'commits': [
      {'hash': 'abc1234', 'subject': '夜间模式的样式', 'at': 0},
    ],
    'files': [
      {'path': 'src/dark.css', 'status': 'A', 'added': 12, 'removed': 0, 'patch': '@@ -0,0 +1 @@\n+body { color: #fff }'},
    ],
    'uncommitted': <Object>[],
    'conflicts': <String>[],
    'behind': 0,
  };
  final events = [
    {'seq': 1, 'playbook': 'p1', 'kind': 'drafted', 'actor': 'system', 'detail': '3 步', 'at': 0, 'text': '拆好了，3 步，等主人看'},
    {
      'seq': 2,
      'playbook': 'p1',
      'node': 'api',
      'kind': 'node_edited',
      'actor': 'user',
      'changes': [
        {'field': '工单', 'from': '旧', 'to': '新'},
      ],
      'at': 1,
      'text': '改了「接口」的工单',
    },
  ];

  testWidgets('a draft: its steps in columns, started; a step changed; its history', (tester) async {
    final routes = Routes();
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(
        farm(),
        view(),
        fakeApi(routes, {'GET /api/playbooks/p1/events': events, 'POST /api/playbooks/p1/act': '开工了', 'PUT /api/playbooks/p1/nodes/ui': '改好了「页面」'}),
        agents: {'tester': agent('tester', '测试小吴')},
        plans: [draft],
      ),
    );
    c.read(panelProvider.notifier).set(FarmPanel.plans);
    await settle(tester);
    expect(find.text('种植计划'), findsOneWidget);
    expect(find.text('等你看'), findsNWidgets(2));
    expect(find.text('先做'), findsOneWidget);
    expect(find.text('第 2 批'), findsOneWidget);
    expect(find.text('等 接口'), findsOneWidget);
    expect(find.text('拆好了，3 步，等主人看'), findsOneWidget);
    expect(find.text('改了「接口」的工单'), findsOneWidget);
    await tester.tap(find.text('开工'));
    await settle(tester);
    expect(routes.calls.where((x) => x.path == '/api/playbooks/p1/act').single.body, {'action': 'start'});
    expect(find.text('开工了'), findsOneWidget);
    await tester.tap(find.text('改').at(2));
    await settle(tester);
    expect(find.text('改好了'), findsOneWidget);
    await tester.ensureVisible(find.text('改好了'));
    await settle(tester);
    await tester.tap(find.text('改好了'));
    await settle(tester);
    final put = routes.calls.where((x) => x.method == 'PUT').single;
    expect(put.path, '/api/playbooks/p1/nodes/ui');
    expect((put.body! as Map)['needs'], ['api']);
    expect(find.text('改好了「页面」'), findsOneWidget);
  });

  testWidgets('asking for a plan', (tester) async {
    final routes = Routes();
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(
        farm(),
        view(),
        fakeApi(routes, {
          'GET /api/projects': [
            {'name': 'clock-in', 'path': '/work/clock-in', 'git': true, 'slots': 3},
          ],
          'POST /api/playbooks': '在拆了（p3）',
        }),
      ),
    );
    c.read(panelProvider.notifier).set(FarmPanel.plans);
    await settle(tester);
    expect(find.text('拆计划'), findsOneWidget);
    await tester.enterText(find.byType(EditableText).first, '给 clock-in 加按月查询');
    await settle(tester);
    await tester.tap(find.text('拆计划'));
    await settle(tester);
    final plan = routes.calls.where((x) => x.path == '/api/playbooks').single;
    expect(plan.body, {'goal': '给 clock-in 加按月查询', 'project': 'clock-in'});
    expect(c.read(planShownProvider), 'p3');
  });

  testWidgets('a ripe playbook: its changes looked over, then harvested', (tester) async {
    final routes = Routes();
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(
        farm(),
        view(),
        fakeApi(routes, {'GET /api/playbooks/p2/events': <Object>[], 'GET /api/playbooks/p2/changes': changes, 'POST /api/playbooks/p2/act': '收进了 main'}),
        plans: [ripe],
      ),
    );
    c.read(panelProvider.notifier).set(FarmPanel.plans);
    await settle(tester);
    expect(find.text('可收获'), findsNWidgets(2));
    expect(find.text('改好了'), findsOneWidget);
    await tester.tap(find.text('看改动，收获…'));
    await settle(tester);
    expect(find.text('夜间模式的样式'), findsOneWidget);
    expect(find.text('src/dark.css'), findsOneWidget);
    await tester.tap(find.text('确认收获，合进 main'));
    await settle(tester);
    expect(routes.calls.last.body, {'action': 'merge'});
    expect(find.text('收进了 main'), findsOneWidget);
  });

  testWidgets("a helper's harvest: commits, files and a diff; then harvested", (tester) async {
    final routes = Routes();
    final w = session('w3', name: '老李', station: 2, phase: const PhaseRipe());
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(farm(sessions: [w]), view(), fakeApi(routes, {'GET /api/issues/tw3/changes': changes})),
    );
    c.read(reviewingProvider.notifier).set('w3');
    await settle(tester);
    expect(find.text('收获老李的地'), findsOneWidget);
    expect(find.text('1 个提交 · 1 个文件'), findsOneWidget);
    expect(find.text('abc1234'), findsOneWidget);
    await tester.tap(find.text('src/dark.css'));
    await settle(tester);
    expect(find.text('+body { color: #fff }'), findsOneWidget);
    await tester.tap(find.text('确认收获，合进 main'));
    await settle(tester);
    expect(routes.calls.last.path, '/api/issues/tw3/merge');
    expect(c.read(reviewingProvider), isNull);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('a harvest that would conflict asks the helper to resolve it', (tester) async {
    final routes = Routes();
    final w = session('w3', name: '老李', station: 2, phase: const PhaseRipe());
    final conflicted = {
      ...changes,
      'conflicts': ['src/dark.css'],
    };
    final c = await pumpFarm(
      tester,
      const FarmPanels(),
      overrides: overrides(farm(sessions: [w]), view(), fakeApi(routes, {'GET /api/issues/tw3/changes': conflicted})),
    );
    c.read(reviewingProvider.notifier).set('w3');
    await settle(tester);
    expect(find.text('合进 main 会冲突，先没法收'), findsOneWidget);
    expect(find.text('冲突'), findsOneWidget);
    await tester.tap(find.text('让它解决冲突'));
    await settle(tester);
    // The server tells it which conflicts (ConflictTask).
    expect(routes.calls.last.path, '/api/issues/tw3/resolve');
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('changes that cannot be read say why', (tester) async {
    final w = session('w3', name: '老李', station: 2, phase: const PhaseRipe());
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(farm(sessions: [w]), view(), fakeApi(Routes())));
    c.read(reviewingProvider.notifier).set('w3');
    await settle(tester);
    expect(find.textContaining('看不了改动：'), findsOneWidget);
    await tester.tap(find.text('先不收'));
    await settle(tester);
    expect(c.read(reviewingProvider), isNull);
  });
}
