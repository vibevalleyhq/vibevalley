import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/data/ui_state.dart';
import 'package:vibevalley/farm/panels.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/farm.dart';

ProjectSummary _project(String name) => ProjectSummary(
  name: name,
  path: '/work/$name',
  git: true,
  slots: 3,
  pullRequest: const PullRequestCapability(available: false, reason: ''),
);

Issue _queued(String id, String title, double at) => Issue(
  id: id,
  number: double.parse(id.substring(1)),
  title: title,
  project: 'clock-in',
  assignee: 'tester',
  priority: Priority.medium,
  createdAt: at,
  queuedAt: at,
  sessions: const [],
  status: IssueStatus.todo,
  moves: const [],
  acceptance: Acceptance.glance,
  findings: const [],
  asks: const [],
);

const _seeds = ProjectSeeds(
  project: 'clock-in',
  stack: ProjectStack(name: 'go', label: 'Go', test: 'go test ./...'),
  recent: ['修登录闪退'],
  kinds: [
    SeedKind(
      id: 'fix',
      name: '修问题',
      icon: 'plot-withered',
      seeds: [
        Seed(
          id: 'bug',
          title: '修一个 bug：〔现象〕',
          done: '先复现它；`go test ./...` 通过',
          text: '修一个 bug：〔现象〕\n做到什么程度算完：先复现它；`go test ./...` 通过',
          blank: SeedBlank(start: 8, end: 12),
        ),
        Seed(id: 'lint', title: '修 lint', done: '代码检查没有报错', text: '修 lint\n做到什么程度算完：代码检查没有报错'),
      ],
    ),
    SeedKind(
      id: 'docs',
      name: '文档',
      icon: 'plot-flowering',
      seeds: [Seed(id: 'readme', title: '补 README 怎么启动', done: '照着能跑起来', text: '补 README 怎么启动\n做到什么程度算完：照着能跑起来')],
    ),
  ],
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final agents = {'tester': agent('tester', '测试小吴'), 'front': agent('front', '前端阿郑')};
  final queued = [_queued('t7', '给打卡页加导出', 2000), _queued('t5', '先排上的', 1000)];
  final state = farm(issues: queued);
  final v = view();

  Routes routes({List<String> projects = const ['clock-in', 'notes']}) => Routes({
    'GET /api/v1/projects': [for (final p in projects) _project(p).toJson()],
    'GET /api/v1/projects/clock-in/seeds': _seeds.toJson(),
    'POST /api/v1/issues/t5/start': const Dispatched(session: 's9').toJson(),
  });

  Future<void> open(WidgetTester tester, Routes r) async {
    final c = await pumpFarm(tester, const FarmPanels(), overrides: overrides(state, v, fakeApi(r), agents: agents));
    c.read(farmOverlaysProvider.notifier).sow(3);
    await settle(tester);
  }

  Future<void> pickClockIn(WidgetTester tester) async {
    expect(find.text('种在哪个项目？'), findsOneWidget, reason: 'an empty bed is no project\'s: it asks');
    await tester.tap(find.text('clock-in'));
    await settle(tester);
  }

  testWidgets('it says where it sows, 最近 first, then the kinds; a template puts the cursor on its first blank', (tester) async {
    final r = routes();
    await open(tester, r);
    await pickClockIn(tester);
    expect(find.text('种在 clock-in'), findsOneWidget);
    expect(find.text('Go'), findsOneWidget);
    expect(r.paths, contains('GET /api/v1/projects/clock-in/seeds'));
    final recentY = tester.getTopLeft(find.text('最近')).dy;
    final kindsY = tester.getTopLeft(find.text('常见的活')).dy;
    expect(recentY, lessThan(kindsY));
    expect(tester.getTopLeft(find.text('修登录闪退')).dy, lessThan(kindsY));
    expect(find.text('修问题'), findsOneWidget);
    expect(find.text('文档'), findsOneWidget);

    await tester.tap(find.text('修一个 bug：〔现象〕'));
    await tester.pump();
    final words = tester.widget<EditableText>(find.descendant(of: find.bySemanticsLabel('工单'), matching: find.byType(EditableText)));
    expect(words.controller.text, _seeds.kinds[0].seeds[0].text);
    expect(words.controller.selection, const TextSelection(baseOffset: 8, extentOffset: 12));
    expect(words.focusNode.hasFocus, isTrue);
    expect(words.controller.selection.textInside(words.controller.text), '〔现象〕');

    await tester.enterText(
      find.descendant(of: find.bySemanticsLabel('工单'), matching: find.byType(EditableText)),
      '修一个 bug：打卡按钮没反应\n做到什么程度算完：先复现它；`go test ./...` 通过',
    );
    await tester.pump();
    await tester.ensureVisible(find.text('前端阿郑'));
    await tester.tap(find.text('前端阿郑'));
    await tester.pump();
    await tester.ensureVisible(find.text('播种').last);
    await tester.tap(find.text('播种').last);
    await settle(tester);
    final say = r.calls.where((x) => x.path == '/api/v1/say').single;
    expect(say.body, {
      'text': '修一个 bug：打卡按钮没反应\n做到什么程度算完：先复现它；`go test ./...` 通过',
      'bed': 3,
      'agent': 'front',
      'project': 'clock-in',
      'sendKey': matches(RegExp(r'^[0-9a-f]{32}$')),
    });
  });

  testWidgets('the filter narrows the seeds; free words still sow', (tester) async {
    final r = routes();
    await open(tester, r);
    await pickClockIn(tester);
    await tester.enterText(find.descendant(of: find.bySemanticsLabel('筛种子'), matching: find.byType(EditableText)), 'readme');
    await tester.pump();
    expect(find.text('补 README 怎么启动'), findsOneWidget);
    expect(find.text('修一个 bug：〔现象〕'), findsNothing);
    expect(find.text('修登录闪退'), findsNothing);
    expect(find.text('修问题'), findsNothing);
    await tester.enterText(find.descendant(of: find.bySemanticsLabel('筛种子'), matching: find.byType(EditableText)), '没有这个');
    await tester.pump();
    expect(find.text('没有对得上的种子：在下面自己写。'), findsOneWidget);
    await tester.enterText(find.descendant(of: find.bySemanticsLabel('工单'), matching: find.byType(EditableText)), '把打卡记录导出成 CSV');
    await tester.pump();
    await tester.ensureVisible(find.text('播种').last);
    await tester.tap(find.text('播种').last);
    await settle(tester);
    final say = r.calls.where((x) => x.path == '/api/v1/say').single;
    expect(say.body, {'text': '把打卡记录导出成 CSV', 'bed': 3, 'project': 'clock-in', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});
  });

  testWidgets('one project is picked without asking', (tester) async {
    await open(tester, routes(projects: ['clock-in']));
    expect(find.text('种在哪个项目？'), findsNothing);
    expect(find.text('种在 clock-in'), findsOneWidget);
  });

  testWidgets('开工待办 starts the queued issue itself on this bed, not a new one', (tester) async {
    final r = routes();
    await open(tester, r);
    await pickClockIn(tester);
    await tester.tap(find.text('开工待办 2'));
    await settle(tester);
    expect(tester.getTopLeft(find.text('#5 先排上的')).dy, lessThan(tester.getTopLeft(find.text('#7 给打卡页加导出')).dy));
    await tester.tap(find.text('开工').first);
    await settle(tester);
    expect(r.named('POST', '/api/v1/issues/t5/start').single.body, {'bed': 3});
    expect(r.paths, isNot(contains('POST /api/v1/say')));
    expect(find.text('播种 · 第 4 块地'), findsNothing, reason: 'started: the bag closes');
  });

  testWidgets('a queued issue still without room says why and the bag stays', (tester) async {
    final r = routes()..answers['POST /api/v1/issues/t5/start'] = const Dispatched(queued: 'clock-in 已经有 3 个在干：还在排队，有空地就自动开工').toJson();
    await open(tester, r);
    await pickClockIn(tester);
    await tester.tap(find.text('开工待办 2'));
    await settle(tester);
    await tester.tap(find.text('开工').first);
    await settle(tester);
    expect(find.text('clock-in 已经有 3 个在干：还在排队，有空地就自动开工'), findsOneWidget);
    expect(find.text('播种 · 第 4 块地'), findsOneWidget);
  });
}
