import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/issues.dart';
import 'package:vibevalley/shared/issue_view.dart';
import 'package:vibevalley/ui/kit/kit.dart';

import '../support/farm.dart' as f;

void main() {
  for (final frame in IssueFrame.values) {
    testWidgets('$frame shows the same issue, history, changes and advice', (t) async {
      final session = f.session(
        'w1',
        project: 'demo',
        branch: 'vibevalley/issue-3',
        worktree: '/worktrees/demo.3',
        phase: const PhaseRipe(),
        last: const LastRun(outcome: Outcome.completed, summary: '测试通过', at: 1000),
        files: ['src/a.ts'],
        commands: ['pnpm test'],
      );
      const issue = Issue(
        id: 'tw1',
        number: 3,
        title: '共享详情',
        project: 'demo',
        priority: Priority.medium,
        createdAt: 0,
        status: IssueStatus.inReview,
        sessions: ['w0', 'w1'],
        moves: [IssueStatus.todo, IssueStatus.done, IssueStatus.canceled],
        acceptance: Acceptance.glance,
        findings: [Finding(id: 'f0', text: '少了边界测试', at: 0, pulled: true)],
        asks: [],
      );
      final previous = f.session('w0', name: '前一位');
      final routes = f.Routes({
        'POST /api/v1/issues/tw1/accept': issue.toJson(),
        'GET /api/v1/issues/tw1/runs': [
          const Run(
            id: 'r1',
            issue: 'tw1',
            session: 'w1',
            triggeredBy: RunTrigger(kind: RunTriggerKind.issue),
            heard: [],
            startedAt: 0,
          ).toJson(),
        ],
        'GET /api/v1/issues/tw1/changes': {'base': 'main', 'branch': 'vibevalley/issue-3', 'commits': [], 'files': [], 'uncommitted': [], 'conflicts': []},
        'GET /api/v1/sessions/w1/events': [const SessionEvent(seq: 1, time: 0, type: SessionEventType.userMessage, text: '开工').toJson()],
      });
      var harvested = 0;
      var closed = 0;
      String? copied;
      t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String;
        return null;
      });
      addTearDown(() => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      final router = GoRouter(
        routes: [
          GoRoute(
            path: '/',
            builder: (_, _) => SingleChildScrollView(
              child: IssueView(
                frame: frame,
                issue: issue,
                sessions: [previous, session],
                session: session,
                state: IssueTag.waiting,
                onHarvest: (_) async {
                  harvested++;
                },
                onClose: (_) async {
                  closed++;
                },
              ),
            ),
          ),
          GoRoute(path: '/projects/:name', builder: (_, state) => Text('项目路径 ${state.uri.path}')),
        ],
      );
      addTearDown(router.dispose);
      await f.pumpFarm(
        t,
        Router.withConfig(config: router),
        overrides: f.overrides(
          f.farm(sessions: [session], issues: [issue]),
          f.view(),
          f.fakeApi(routes),
          agents: {'tester': f.agent('tester', '测试员')},
        ),
      );
      await f.settle(t);
      for (final text in [
        '共享详情',
        '小吴（claude）',
        'demo',
        'vibevalley/issue-3',
        '/worktrees/demo.3',
        '看测试员的档案',
        '开单',
        '做过',
        '用时',
        '测试通过',
        '改动',
        '每次干活',
        '干活过程',
        '这一轮做了什么',
        '碰过的文件',
        '跑过的命令',
        '聊清楚 ✓',
        '安排活 ✓',
        '这块地现在需要你：验收',
        '看一眼就收',
        '必须过验收',
        '已拔 · 少了边界测试',
      ]) {
        expect(find.text(text), findsOneWidget, reason: '$frame: $text');
      }
      expect(find.byType(frame == IssueFrame.farm ? FarmSection : PxCard), findsWidgets);
      await t.tap(find.text('复制路径'));
      expect(copied, '/worktrees/demo.3');
      // Acceptance is the server's: a pass goes to issue.accept.
      await t.tap(find.text('验收通过'));
      await f.settle(t);
      expect(routes.named('POST', '/api/v1/issues/tw1/accept').single.body, {'pass': true});
      await t.tap(find.text('收获'));
      await f.settle(t);
      expect(harvested, 1);
      await t.tap(find.text('关上'));
      await f.settle(t);
      expect(closed, 1);
      await t.ensureVisible(find.byType(EditableText).last);
      await t.enterText(find.byType(EditableText).last, '补一个测试');
      await t.pump();
      await t.tap(find.widgetWithText(PxButton, '带话'));
      await f.settle(t);
      expect(routes.named('POST', '/api/v1/issues/tw1/comment').single.body, {'text': '补一个测试'});
      await t.ensureVisible(find.text('demo'));
      await t.tap(find.text('demo'));
      await f.settle(t);
      expect(find.text('项目路径 /projects/demo'), findsOneWidget);
      await t.pump(const Duration(seconds: 3));
      expect(t.takeException(), isNull);
    });
  }

  testWidgets('每次干活 reads the runs again when the issue moves on, without setState returning its Future', (t) async {
    var reads = 0;
    final routes = f.Routes({
      'GET /api/v1/issues/tw1/runs': (_) {
        reads++;
        return <Object>[];
      },
    });
    final version = ValueNotifier('waiting');
    addTearDown(version.dispose);
    await f.pumpFarm(
      t,
      ValueListenableBuilder<String>(
        valueListenable: version,
        builder: (_, v, _) => IssueRunsCard(issue: 'tw1', version: v),
      ),
      overrides: f.overrides(f.farm(), f.view(), f.fakeApi(routes)),
    );
    await f.settle(t);
    version.value = 'done';
    await f.settle(t);
    expect(t.takeException(), isNull);
    expect(reads, 2);
  });
}
