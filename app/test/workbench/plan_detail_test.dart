import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/ui/pro/pro.dart';
import 'package:vibevalley/workbench/issues/plan_detail.dart';

import '../support/farm.dart';

void main() {
  const actions = {'start': '开工', 'pause': '暂停', 'resume': '继续', 'abandon': '放弃', 'merge': '收获'};

  setUp(() => SharedPreferences.setMockInitialValues({}));

  Task node(String id, String title, {List<String> needs = const [], List<String>? blockedBy, TaskState state = TaskState.waiting, List<TaskAction>? acts}) =>
      Task(
        id: id,
        title: title,
        brief: '做$title',
        needs: needs,
        blockedBy: blockedBy,
        state: state,
        tries: 0,
        stateText: switch (state) {
          TaskState.waiting => '等着',
          TaskState.working => '在做',
          TaskState.merged => '合进去了',
          TaskState.failed => '没做成',
          TaskState.skipped => '跳过了',
        },
        actions: acts,
        actionText: const {'retry': '重试', 'skip': '跳过'},
      );

  final plan = TaskGraph(
    id: 'p1',
    title: '按月查打卡',
    goal: '给 clock-in 加按月查询',
    project: 'clock-in',
    state: GraphState.running,
    stateTag: '在做',
    actions: const [GraphAction.pause, GraphAction.abandon],
    actionText: actions,
    tasks: [
      node('api', '接口', state: TaskState.failed, acts: const [TaskAction.retry, TaskAction.skip]),
      node('ui', '页面', needs: ['api'], blockedBy: ['api']),
      node('docs', '文档', state: TaskState.merged),
    ],
    parallel: 2,
    createdAt: 0,
    layers: [
      ['api', 'docs'],
      ['ui'],
    ],
    settled: 1,
  );

  testWidgets('a plan reads as an issue with its steps under it: folded to state and what each waits on, opened to act', (t) async {
    final routes = Routes();
    String? opened;
    await pumpFarm(
      t,
      ProScope(
        child: SingleChildScrollView(
          child: PlanDetail(graph: plan, stepIssues: const {'api': 'i-api'}, onOpen: (id) => opened = id),
        ),
      ),
      overrides: overrides(farm(), view(), fakeApi(routes, {'POST /api/v1/graphs/p1/tasks/api/act': '重试了「接口」', 'POST /api/v1/graphs/p1/act': '暂停了'})),
    );
    for (final text in ['按月查打卡', '做完 1 / 3 步', '第 1 批 · 这 2 步可以同时做', '第 2 批', '接口', '页面', '文档']) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    expect(find.text('等着 · 等「接口」'), findsOneWidget, reason: 'a waiting step says what it waits on, folded');
    expect(find.text('做接口'), findsNothing, reason: 'a step is folded at first');

    await t.tap(find.text('接口'));
    await settle(t);
    expect(find.text('做接口'), findsOneWidget);
    await t.tap(find.text('打开这张工单'));
    expect(opened, 'i-api', reason: 'a step a helper worked opens as its own issue');
    await t.tap(find.text('重试'));
    await settle(t);
    expect(routes.calls.where((c) => c.path == '/api/v1/graphs/p1/tasks/api/act').single.body, {'action': 'retry'});
    expect(find.text('重试了「接口」'), findsOneWidget, reason: 'what the server said is shown');

    await t.tap(find.text('暂停'));
    await settle(t);
    expect(routes.calls.where((c) => c.path == '/api/v1/graphs/p1/act').single.body, {'action': 'pause'});
  });
}
