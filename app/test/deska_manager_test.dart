import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/manager/manager_page.dart';
import 'package:vibevalley/desk/shared/memory_panels.dart';
import 'package:vibevalley/desk/shared/work_log.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'deska_fakes.dart';

final _now = DateTime.now().millisecondsSinceEpoch.toDouble();

WorkStep _step(double n, StepKind kind, String text, {String? input, String? output, bool? ok}) =>
    WorkStep(n: n, at: _now, kind: kind, text: text, action: kind == StepKind.tool ? ToolAction.runCommand : null, input: input, output: output, ok: ok);

FakeServer _server() => FakeServer(
  managerMemory: ManagerMemory(
    runtime: Runtime.vibevalley,
    file: '/home/me/.vibevalley/MEMORY.md',
    memories: [
      memory('n1', '提交信息写中文', agent: 'foreman', helper: 'foreman', at: _now),
      memory('n0', '很旧的一条', agent: 'foreman', at: _now),
    ],
    carried: 1,
  ),
  archive: ArchiveListing(
    files: [ArchiveFile(name: '2026-10-01.md', at: _now, chars: 1200)],
    hits: const [ArchiveHit(file: '2026-10-01.md', line: 12, text: '主人说：登录页要改')],
  ),
  archiveFiles: const {'2026-10-01.md': '主人：把登录页改一下\n管家：好'},
  trajectories: {
    'foreman': Trajectory(
      head: TrajectoryHead(id: 'foreman', name: '管家', startedAt: _now),
      steps: [
        _step(1, StepKind.asked, '帮我跑测试'),
        _step(2, StepKind.tool, 'pnpm test', input: '{"command":"pnpm test"}', output: '12 passed', ok: true),
        _step(3, StepKind.said, '测试都过了。'),
      ],
    ),
    'h1': Trajectory(
      head: TrajectoryHead(id: 'h1', name: '老周一号', agent: 'backend', project: 'clock', job: '改登录', startedAt: _now),
      steps: [_step(1, StepKind.asked, '改登录')],
    ),
  },
  heads: [TrajectoryHead(id: 'h1', name: '老周一号', agent: 'backend', project: 'clock', job: '改登录', startedAt: _now, endedAt: _now)],
  memories: {
    'backend': [
      memory('j1', '登录改到一半', kind: MemoryKind.job, project: 'clock', at: _now),
      memory('a1', 'clock 的测试用 pnpm test', project: 'clock', at: _now),
      memory('a2', '提交前跑 lint', at: _now),
    ],
  },
  projects: const [ProjectSummary(name: 'clock', path: '/work/clock', git: true, last: 2, slots: 3)],
  settings: SettingsStatus(
    file: '/home/me/.vibevalley/settings.json',
    deepseekApiKey: const KeyStatus(),
    agoraAppId: const AgoraAppId(),
    agoraAppCertificate: const KeyStatus(),
    voice: voice(),
    voiceDefaults: voice(),
    asrKey: const KeyStatus(),
    llmKey: const KeyStatus(),
    ttsKey: const KeyStatus(),
  ),
);

void main() {
  group('ManagerPage', () {
    testWidgets('记性 lists the manager\'s notes, the ones past what it carries faded, and writes one', (t) async {
      final server = _server();
      await pumpPage(t, server, const ManagerPage());
      expect(find.text('提交信息写中文'), findsOneWidget);
      expect(find.text('管家自己记的'), findsOneWidget);
      expect(find.text('太旧了，带不进系统提示'), findsOneWidget);
      expect(find.text('/home/me/.vibevalley/MEMORY.md'), findsOneWidget);
      await typeInto(t, '替它记一条', '周末别派夜班');
      await t.tap(find.text('记下'));
      await settle(t);
      final post = server.writes.single;
      expect(post.method, 'POST');
      expect(post.path, '/api/manager/memories');
      expect(post.body, {'text': '周末别派夜班'});
      expect(find.text('周末别派夜班'), findsOneWidget);
    });

    testWidgets('忘掉 forgets a note', (t) async {
      final server = _server();
      await pumpPage(t, server, const ManagerPage(tab: 'memory'));
      await t.tap(labelled('忘掉').first);
      await settle(t);
      expect(server.writes.single.method, 'DELETE');
      expect(server.writes.single.path, '/api/manager/memories/n1');
      expect(find.text('提交信息写中文'), findsNothing);
    });

    testWidgets('轨迹 shows the manager\'s steps; a tool opens to its input and output', (t) async {
      final server = _server();
      await pumpPage(t, server, const ManagerPage(tab: 'trajectory'));
      expect(find.text('收到'), findsOneWidget);
      expect(find.text('帮我跑测试'), findsOneWidget);
      expect(find.text('测试都过了。', findRichText: true), findsOneWidget);
      await t.tap(find.text('pnpm test'));
      await t.pump();
      expect(find.text('\$ pnpm test'), findsOneWidget);
      expect(find.text('12 passed'), findsOneWidget);
    });

    testWidgets('a step event adds to the trajectory as it comes', (t) async {
      final server = _server();
      final events = StreamController<SiteEvent>.broadcast();
      addTearDown(events.close);
      await pumpPage(t, server, const ManagerPage(tab: 'trajectory'), events: events.stream);
      events.add(SiteEventStep(at: _now, id: 'foreman', step: _step(4, StepKind.problem, '网断了')));
      await settle(t);
      expect(find.text('网断了'), findsOneWidget);
    });

    testWidgets('旧账 lists the archive, searches it, and opens a file', (t) async {
      final server = _server();
      await pumpPage(t, server, const ManagerPage(tab: 'archive'));
      expect(find.text('2026-10-01.md'), findsOneWidget);
      await typeInto(t, '在旧账里搜', '登录');
      await t.tap(find.text('搜'));
      await settle(t);
      expect(server.calls.last.path, '/api/manager/archive?q=%E7%99%BB%E5%BD%95');
      expect(find.text('主人说：登录页要改'), findsOneWidget);
      await t.tap(labelled('2026-10-01.md'));
      await settle(t);
      expect(find.text('主人：把登录页改一下\n管家：好'), findsOneWidget);
    });

    testWidgets('声音 saves the greeting as an override of the defaults', (t) async {
      final server = _server();
      await pumpPage(t, server, const ManagerPage(tab: 'voice'));
      expect(find.text('都存着。'), findsOneWidget);
      await typeInto(t, '开场白', '来了来了');
      expect(find.text('有没存的改动。'), findsOneWidget);
      await t.ensureVisible(find.text('保存'));
      await t.pump();
      await t.tap(find.text('保存'));
      await settle(t);
      final put = server.writes.single;
      expect(put.method, 'PUT');
      expect(put.path, '/api/settings');
      expect(put.body, {
        'voice': {'greeting': '来了来了'},
      });
      expect(find.text('存好了，下一通电话就用上。'), findsOneWidget);
    });
  });

  group('a helper agent\'s memory and trajectories', () {
    testWidgets('MemoryPanel shows its jobs, what the next turn would recall, its notes, and writes one for a project', (t) async {
      final server = _server();
      await pumpPage(t, server, const SingleChildScrollView(child: MemoryPanel(agent: 'backend')));
      expect(find.text('登录改到一半'), findsOneWidget);
      expect(find.text('- （这个项目）clock 的测试用 pnpm test\n- （所有项目）提交前跑 lint\n- 做过（这个项目）：登录改到一半'), findsOneWidget);
      await t.tap(find.text('所有项目').first);
      await t.pump();
      expect(find.text('clock 的测试用 pnpm test'), findsNothing);
      await typeInto(t, '替它记一条', '用 pnpm');
      await typeInto(t, '项目', 'clock');
      await t.tap(find.text('记下'));
      await settle(t);
      final post = server.writes.single;
      expect(post.path, '/api/agents/backend/memories');
      expect(post.body, {'text': '用 pnpm', 'project': 'clock'});
    });

    testWidgets('TrajectoryList lists the helpers it sent and opens one', (t) async {
      final server = _server();
      await pumpPage(t, server, const SingleChildScrollView(child: TrajectoryList(agent: 'backend')));
      expect(server.calls.first.path, '/api/trajectories?agent=backend');
      expect(find.text('老周一号'), findsOneWidget);
      expect(find.text('改登录'), findsOneWidget);
      await t.tap(labelled('老周一号'));
      await settle(t);
      expect(find.text('工单'), findsOneWidget);
    });
  });
}
