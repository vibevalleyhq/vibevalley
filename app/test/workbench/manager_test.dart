import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/workbench/manager/manager_page.dart';
import 'package:vibevalley/workbench/shared/memory_panels.dart';
import 'package:vibevalley/shared/work_log.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/workbench.dart';

final _now = DateTime.now().millisecondsSinceEpoch.toDouble();

SessionEvent _step(double n, SessionEventType kind, String text, {String? input, String? output, bool? ok}) => SessionEvent(
  seq: n,
  time: _now,
  type: kind,
  text: text,
  action: kind == SessionEventType.toolCall ? ToolAction.runCommand : null,
  input: input,
  output: output,
  ok: ok,
);

WorkbenchBackend _server() => WorkbenchBackend(
  managerMemory: MemoryList(
    file: '/home/me/.vibevalley/MEMORY.md',
    sources: const [],
    memories: [
      memory('n1', '提交信息写中文', agent: 'manager', session: 'manager', at: _now),
      memory('n0', '很旧的一条', agent: 'manager', at: _now),
    ],
    carried: 1,
  ),
  archive: ArchiveListing(
    files: [ArchiveFile(name: '2026-10-01.md', at: _now, chars: 1200)],
    hits: const [ArchiveHit(file: '2026-10-01.md', line: 12, text: '主人说：登录页要改')],
  ),
  archiveFiles: const {'2026-10-01.md': '主人：把登录页改一下\n管家：好'},
  events: {
    'manager': [
      _step(1, SessionEventType.userMessage, '帮我跑测试'),
      _step(2, SessionEventType.toolCall, 'pnpm test', input: '{"command":"pnpm test"}', output: '12 passed', ok: true),
      _step(3, SessionEventType.assistantMessage, '测试都过了。'),
    ],
    'h1': [_step(1, SessionEventType.userMessage, '改登录')],
  },
  heads: [
    Session(
      id: 'h1',
      name: '老周一号',
      agent: 'backend',
      runtime: 'claude',
      project: 'clock',
      task: '改登录',
      hiredAt: _now,
      runs: 1,
      phase: PhaseClosed(at: _now, closed: IssueClose.dismissed),
    ),
  ],
  memories: {
    'backend': [
      memory('j1', '登录改到一半', kind: MemoryKind.issue, project: 'clock', at: _now),
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
    dictation: const Dictation(url: '', model: ''),
    dictationKey: const KeyStatus(),
    memorySources: const [],
  ),
);

void main() {
  group('ManagerPage', () {
    testWidgets('记性 lists the manager\'s notes, the ones past what it carries faded, and writes one', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(), server.handle);
      expect(find.text('提交信息写中文'), findsOneWidget);
      expect(find.text('管家自己记的'), findsOneWidget);
      expect(find.text('太旧了，带不进系统提示'), findsOneWidget);
      expect(find.text('/home/me/.vibevalley/MEMORY.md'), findsOneWidget);
      await typeInto(t, '替它记一条', '周末别派夜班');
      await t.tap(find.text('记下'));
      await settle(t);
      final post = server.writes.single;
      expect(post.method, 'POST');
      expect(post.path, '/api/v1/memories/manager');
      expect(post.body, {'text': '周末别派夜班'});
      expect(find.text('周末别派夜班'), findsOneWidget);
    });

    testWidgets('忘掉 forgets a note', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(tab: 'memory'), server.handle);
      await t.tap(labelled('忘掉').first);
      await settle(t);
      expect(server.writes.single.method, 'DELETE');
      expect(server.writes.single.path, '/api/v1/memories/manager/n1');
      expect(find.text('提交信息写中文'), findsNothing);
    });

    testWidgets('轨迹 shows the manager\'s steps; a tool opens to its input and output', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(tab: 'trajectory'), server.handle);
      expect(find.text('收到'), findsOneWidget);
      expect(find.text('帮我跑测试'), findsOneWidget);
      expect(find.text('测试都过了。', findRichText: true), findsOneWidget);
      await t.tap(find.text('pnpm test'));
      await t.pump();
      expect(find.text('\$ pnpm test'), findsOneWidget);
      expect(find.text('12 passed'), findsOneWidget);
    });

    testWidgets('这一轮做错了 saves the round as a case with what it should have done, and marks it', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(tab: 'trajectory'), server.handle);
      await t.tap(find.text('帮我跑测试'));
      await t.pump();
      await t.tap(find.text('这一轮做错了'));
      await t.pump();
      await typeInto(t, '这一轮应该怎样', '先问我是哪个项目');
      await t.tap(find.text('记下'));
      await settle(t);
      final post = server.writes.single;
      expect(post.method, 'POST');
      expect(post.path, '/api/v1/manager/evals');
      expect(post.body, {'on': 1, 'want': '先问我是哪个项目'});
      expect(find.text('标成了做错的一轮，存成了一条评测'), findsOneWidget);
      expect(find.text('这一轮做错了'), findsNothing);
    });

    testWidgets('a step event adds to the trajectory as it comes', (t) async {
      final server = _server();
      final events = StreamController<LiveEvent>.broadcast();
      addTearDown(events.close);
      await pumpPage(t, const ManagerPage(tab: 'trajectory'), server.handle, events: events.stream);
      events.add(LiveEventSession(at: _now, id: 'manager', activity: _step(4, SessionEventType.runError, '网断了')));
      await settle(t);
      expect(find.text('网断了'), findsOneWidget);
    });

    testWidgets('旧账 lists the archive, searches it, and opens a file', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(tab: 'archive'), server.handle);
      expect(find.text('2026-10-01.md'), findsOneWidget);
      await typeInto(t, '在旧账里搜', '登录');
      await t.tap(find.text('搜'));
      await settle(t);
      expect(server.calls.last.path, '/api/v1/manager/archive?q=%E7%99%BB%E5%BD%95');
      expect(find.text('主人说：登录页要改'), findsOneWidget);
      await t.tap(labelled('2026-10-01.md'));
      await settle(t);
      expect(find.text('主人：把登录页改一下\n管家：好'), findsOneWidget);
    });

    testWidgets('声音 saves the greeting with the voice', (t) async {
      final server = _server();
      await pumpPage(t, const ManagerPage(tab: 'voice'), server.handle);
      expect(find.text('都存着。'), findsOneWidget);
      await typeInto(t, '开场白', '来了来了');
      expect(find.text('有没存的改动。'), findsOneWidget);
      await t.ensureVisible(find.text('保存'));
      await t.pump();
      await t.tap(find.text('保存'));
      await settle(t);
      final put = server.writes.single;
      expect(put.method, 'PUT');
      expect(put.path, '/api/v1/settings');
      // The voice goes whole; the server keeps what differs from its defaults.
      expect(((put.body! as Map)['voice'] as Map)['greeting'], '来了来了');
      expect(find.text('存好了，下一通电话就用上。'), findsOneWidget);
    });
  });

  group('a helper agent\'s memory and trajectories', () {
    testWidgets('MemoryPanel shows its jobs, what the next turn would recall, its notes, and writes one for a project', (t) async {
      final server = _server()..recalls['backend'] = ['- （这个项目）clock 的测试用 pnpm test', '- （所有项目）提交前跑 lint', '- 做过（这个项目）：登录改到一半'];
      await pumpPage(t, const SingleChildScrollView(child: MemoryPanel(agent: 'backend')), server.handle);
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
      expect(post.path, '/api/v1/memories/backend');
      expect(post.body, {'text': '用 pnpm', 'project': 'clock'});
    });

    testWidgets('MemoryPanel shows where its memories live, and offers to forget only where that can be done', (t) async {
      final server = _server()
        ..memorySources['backend'] = const [
          MemorySourceInfo(name: 'local', label: '本地', on: true, canList: true, canForget: true, transcripts: false),
          MemorySourceInfo(name: 'nowledge', label: 'Nowledge Mem', on: true, canList: true, canForget: false, transcripts: false),
        ]
        ..memories['backend']!.add(
          const Memory(id: 'nowledge:nm-1', agent: 'backend', kind: MemoryKind.note, text: '部署用 make deploy', at: 0, recalled: 0, source: 'nowledge'),
        );
      await pumpPage(t, const SingleChildScrollView(child: MemoryPanel(agent: 'backend')), server.handle);
      expect(find.textContaining('记性从哪来', findRichText: true), findsOneWidget);
      expect(find.text('Nowledge Mem'), findsOneWidget);
      expect(find.text('要删到它那里删'), findsOneWidget);
      expect(find.text('部署用 make deploy'), findsOneWidget);
      expect(find.text('在 Nowledge Mem 里'), findsOneWidget);
      expect(labelled('忘掉'), findsNWidgets(2));
    });

    testWidgets('TrajectoryList lists the helpers it sent and opens one', (t) async {
      final server = _server();
      await pumpPage(t, const SingleChildScrollView(child: TrajectoryList(agent: 'backend')), server.handle);
      expect(server.calls.first.path, '/api/v1/sessions?agent=backend');
      expect(find.text('老周一号'), findsOneWidget);
      expect(find.text('改登录'), findsOneWidget);
      await t.tap(labelled('老周一号'));
      await settle(t);
      expect(find.text('工单'), findsOneWidget);
    });
  });
}
