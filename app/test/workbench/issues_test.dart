import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/workbench/issues/issues_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/issues.dart';
import 'package:vibevalley/ui/kit/kit.dart' show toasts;
import 'package:shared_preferences/shared_preferences.dart';

import '../support/server.dart' show FakeServer, jsonResponse, settle;
import '../support/farm.dart' as fakes;
import '../support/workbench.dart' show pumpPage, WorkbenchBackend;

const _closed = Session(
  id: 'w1',
  name: '小吴',
  agent: 'backend',
  runtime: 'claude',
  project: 'clock',
  brief: '写打卡\n细节在 README',
  hiredAt: 0,
  runs: 2,
  phase: PhaseClosed(at: 60000, closed: IssueClose.merged),
  lastRun: LastRun(outcome: Outcome.completed, summary: '打卡写好了，测试全过', at: 60000),
  spent: Spent(tokens: 0, cny: 0.42),
);
const _open = Session(id: 'w2', name: '小郑', agent: 'frontend', runtime: '', project: 'clock', brief: '改登录页', hiredAt: 70000, runs: 0, phase: PhaseResting());

Issue _issue(
  String id,
  String text, {
  List<String> sessions = const [],
  IssueStatus status = IssueStatus.backlog,
  IssueClose? closed,
  String? parent,
  IssueGraph? graph,
  List<IssueStatus> moves = const [],
}) => Issue(
  id: id,
  number: 1,
  title: text,
  project: 'clock',
  assignee: 'backend',
  priority: Priority.medium,
  createdAt: 0,
  sessions: sessions,
  closedAt: closed == null ? null : 60000,
  closed: closed,
  parent: parent,
  graph: graph,
  status: status,
  moves: moves,
);

final _closedIssue = _issue('t1', '写打卡', sessions: ['w1'], status: IssueStatus.done, closed: IssueClose.merged);
final _openIssue = _issue('t2', '改登录页', sessions: ['w2'], status: IssueStatus.inReview);

class _Issues extends Notifier<List<Issue>> {
  List<Issue> seed = const [];
  @override
  List<Issue> build() => seed;
  void set(List<Issue> issues) => state = issues;
}

final _issuesNow = NotifierProvider<_Issues, List<Issue>>(_Issues.new);

Object historyOf(List<Issue> issues, List<Session> sessions) => [
  for (final issue in issues)
    IssueHistory(
      issue: issue,
      sessions: [for (final id in issue.sessions) ...sessions.where((s) => s.id == id)],
      missingSessions: [
        for (final id in issue.sessions)
          if (!sessions.any((s) => s.id == id)) id,
      ],
    ).toJson(),
];

void main() {
  for (final exists in [true, false]) {
    testWidgets('issue lookup waits for a successful history response before deciding missing: $exists', (t) async {
      const issue = Issue(id: 'delayed', number: 1, title: '延迟工单', priority: Priority.medium, createdAt: 1, sessions: [], status: IssueStatus.todo, moves: []);
      final response = Completer<http.Response>();
      final backend = WorkbenchBackend();
      await pumpPage(
        t,
        const IssuesPage(id: 'delayed'),
        (r) => r.url.path == '/api/v1/issues/history' ? response.future : backend.handle(r),
        farm: fakes.farm(issues: const [issue]),
      );
      expect(find.text('找不到这张工单'), findsNothing);
      response.complete(jsonResponse([if (exists) const IssueHistory(issue: issue, sessions: [], missingSessions: []).toJson()]));
      await settle(t);
      expect(find.text('找不到这张工单'), exists ? findsNothing : findsOneWidget);
      if (exists) expect(find.text('延迟工单'), findsWidgets);
      expect(backend.calls.where((c) => c.path == '/api/v1/sessions'), isEmpty);
    });
  }

  testWidgets('missing execution records remain explicit and do not invent a resting helper', (t) async {
    const issue = Issue(
      id: 'missing',
      number: 1,
      title: '历史工单',
      priority: Priority.medium,
      createdAt: 1,
      sessions: ['lost-session'],
      status: IssueStatus.inReview,
      moves: [],
    );
    final backend = WorkbenchBackend();
    await pumpPage(t, const IssuesPage(id: 'missing'), (r) async {
      if (r.url.path == '/api/v1/issues/history') {
        return jsonResponse([
          const IssueHistory(issue: issue, sessions: [], missingSessions: ['lost-session']).toJson(),
        ]);
      }
      return backend.handle(r);
    }, farm: fakes.farm(issues: const [issue]));
    expect(find.textContaining('执行记录缺失：lost-session'), findsOneWidget);
    expect(find.text('收获'), findsNothing);
    expect(backend.calls.where((c) => c.path == '/api/v1/sessions'), isEmpty);
  });

  test("an issue for the manager: in 处理中 while the manager works on it, closed once it answered", () {
    const working = Issue(
      id: 't9',
      number: 1,
      title: '看进度',
      assignee: managerAgent,
      priority: Priority.medium,
      createdAt: 0,
      sessions: [],
      status: IssueStatus.inProgress,
      moves: [],
    );
    expect(isForManager(working), isTrue);
    expect(laneOf(working.status), Lane.working);
    const answered = Issue(
      id: 't9',
      number: 1,
      title: '看进度',
      assignee: managerAgent,
      priority: Priority.medium,
      createdAt: 0,
      sessions: [],
      closedAt: 1,
      closed: IssueClose.answered,
      status: IssueStatus.done,
      moves: [],
    );
    expect(issueTag(answered), IssueTag.answered);
    expect(laneOf(answered.status), Lane.closed);
    expect(isForManager(_issue('t1', 'x')), isFalse);
  });

  test('a run in one line: what started it, how it went, how long, what it cost, what it heard', () {
    String took(double ms) => '${(ms / 60000).round()} 分钟';
    const done = Run(
      id: 'r1',
      session: 'w1',
      triggeredBy: RunTrigger(kind: RunTriggerKind.comment, message: 'm42'),
      heard: ['m43', 'm44'],
      startedAt: 0,
      endedAt: 180000,
      outcome: Outcome.completed,
      spent: Spent(tokens: 10, cny: 0.5),
    );
    expect(runText(done, 999999, took), '带话（#m42） · 做完了 · 3 分钟 · ¥0.50 · 中途听到 2 句');
    const going = Run(
      id: 'r2',
      session: 'w1',
      triggeredBy: RunTrigger(kind: RunTriggerKind.schedule, missed: true),
      heard: [],
      startedAt: 0,
    );
    expect(runText(going, 120000, took), '定时（补跑） · 正在干 · 2 分钟');
    expect(runTriggerText(const RunTrigger(kind: RunTriggerKind.runtime)), '农机自己');
  });

  test("an issue's state: the server's status while open, how it closed after", () {
    expect(issueTag(_openIssue), IssueTag.waiting);
    expect(issueTag(_issue('t3', 'x', sessions: ['w3'], status: IssueStatus.inProgress)), IssueTag.working);
    expect(issueTag(_closedIssue), IssueTag.harvested);
    expect(issueTag(_issue('t0', 'x', sessions: ['w0'], status: IssueStatus.canceled)), IssueTag.closed);
    final task = _issue('p1.api', '写接口', sessions: ['w4'], status: IssueStatus.done, closed: IssueClose.mergedIntoGraph, parent: 'p1');
    expect(issueTag(task), IssueTag.merged);
    expect(issueInTask(task, null), isTrue);
    const greet = TaskGraph(id: 'p1', title: '加 greet', goal: '加 greet', project: 'demo', state: GraphState.draft, tasks: [], parallel: 1, createdAt: 0);
    expect(issueTitle(task, [greet]), '加 greet · 写接口');
    expect(issueTitle(task), '写接口');
    expect(issueTitle(_closedIssue), '写打卡');
    expect(issueIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 'w1'), isTrue);
    expect(issueIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 't5'), isTrue);
    expect(issueIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 'w2'), isFalse);
  });

  test('what dragging between lanes does: only where the server lets it go', () {
    const all = IssueStatus.values;
    expect(moveOf(Lane.todo, Lane.working, all), Move.start);
    expect(moveOf(Lane.waiting, Lane.closed, all), Move.close);
    expect(moveOf(Lane.working, Lane.closed, all), Move.close);
    expect(moveOf(Lane.closed, Lane.working, all), Move.reopen);
    for (final (from, to) in [
      (Lane.todo, Lane.closed),
      (Lane.working, Lane.waiting),
      (Lane.waiting, Lane.todo),
      (Lane.closed, Lane.todo),
      (Lane.todo, Lane.todo),
    ]) {
      expect(moveOf(from, to, all), isNull, reason: '$from → $to');
    }
    expect(laneOf(IssueStatus.canceled), Lane.closed);
    expect(laneOf(IssueStatus.todo), Lane.todo);
    expect(moveOf(Lane.waiting, Lane.closed, const []), isNull);
    expect(moveOf(Lane.closed, Lane.working, const [IssueStatus.backlog]), isNull);
    expect(moveOf(Lane.working, Lane.closed, const [IssueStatus.canceled]), Move.close);
    expect(issueInTask(_issue('t5', 'x', sessions: ['w5'], status: IssueStatus.done, closed: IssueClose.mergedIntoGraph), null), isTrue);
    expect(issueInTask(_closedIssue, null), isFalse);
  });

  testWidgets("an issue whose harvest would conflict offers to have it solved, not to harvest; a splitter's issue reads as the task's", (t) async {
    t.view.physicalSize = const Size(1600, 1000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    SharedPreferences.setMockInitialValues({});
    final writes = <String>[];
    const conflicted = Session(
      id: 'w4',
      name: '省钱小工 2',
      agent: 'flash',
      runtime: '',
      project: 'demo',
      brief: '改成 hey',
      hiredAt: 0,
      runs: 0,
      phase: PhaseResting(),
    );
    const splitter = Session(
      id: 'w5',
      name: '省钱小工',
      agent: 'flash',
      runtime: '',
      project: 'demo',
      brief: '这一轮你是规划师：……',
      hiredAt: 0,
      runs: 0,
      phase: PhaseClosed(at: 1, closed: IssueClose.merged),
    );
    final issues = [
      _issue('t4', '改成 hey', sessions: ['w4'], status: IssueStatus.inReview),
      _issue(
        'p1',
        '加 greet',
        sessions: ['w5'],
        status: IssueStatus.inReview,
        graph: const IssueGraph(state: GraphState.draft, parallel: 1),
      ),
      _issue('p1.api', '写接口', parent: 'p1'),
    ];
    final api = FakeServer((r) async {
      if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
      return switch ((r.method, r.url.path)) {
        ('GET', '/api/v1/issues/history') => jsonResponse(historyOf(issues, [conflicted, splitter])),
        ('GET', '/api/v1/agents') || ('GET', '/api/v1/skills') || ('GET', '/api/v1/runtimes') => jsonResponse([]),
        ('GET', '/api/v1/sessions/w4') => jsonResponse(conflicted.toJson()),
        ('GET', '/api/v1/sessions/w4/events') => jsonResponse([]),
        _ => jsonResponse(null, 204),
      };
    }).api;
    final session = fakes.session(
      'w4',
      phase: const PhaseRipe(),
      project: 'demo',
      conflict: const Conflict(base: 'main', files: ['hello.py']),
    );
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          apiProvider.overrideWithValue(api),
          stateProvider.overrideWithValue(fakes.farm(sessions: [session], issues: issues)),
          graphsProvider.overrideWithValue(const [
            TaskGraph(id: 'p1', title: '加 greet', goal: '加 greet', project: 'demo', state: GraphState.draft, tasks: [], parallel: 1, createdAt: 0),
          ]),
          sideEventsProvider.overrideWith((ref) => const Stream<LiveEvent>.empty()),
        ],
        child: MaterialApp(
          theme: farmTheme(),
          home: const Scaffold(body: IssuesPage(id: 'w4')),
        ),
      ),
    );
    await settle(t);
    expect(find.text('收获'), findsNothing);
    expect(find.text('计划：加 greet'), findsOneWidget);
    expect(find.text('写接口'), findsNothing);
    await t.tap(find.text('让它解决冲突'));
    await settle(t);
    expect(writes.single, startsWith('POST /api/v1/issues/tw4/resolve'));
  });

  testWidgets('a card per job in its lane; a 待办 dragged into 处理中 is sent; a closed one reopened', (t) async {
    t.view.physicalSize = const Size(1600, 1000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    SharedPreferences.setMockInitialValues({
      'vibevalley.board.pick': ['backend', 'clock'],
    });
    final writes = <String>[];
    var issues = [
      const Issue(
        id: 'a1',
        number: 1,
        title: '加日志',
        project: 'clock',
        assignee: 'backend',
        priority: Priority.urgent,
        createdAt: 0,
        sessions: [],
        status: IssueStatus.backlog,
        moves: [IssueStatus.todo, IssueStatus.canceled],
      ),
      const Issue(
        id: 'a2',
        number: 1,
        title: '改文案',
        project: 'site',
        priority: Priority.medium,
        createdAt: 1,
        sessions: [],
        status: IssueStatus.backlog,
        moves: [IssueStatus.todo, IssueStatus.canceled],
      ),
      _openIssue,
      _issue('t1', '写打卡', sessions: ['w1'], status: IssueStatus.done, closed: IssueClose.merged, moves: [IssueStatus.todo]),
    ];
    late ProviderContainer container;
    void changed() => container.read(_issuesNow.notifier).set(issues);
    final api = FakeServer((r) async {
      if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
      switch ((r.method, r.url.path)) {
        case ('GET', '/api/v1/issues/history'):
          return jsonResponse(historyOf(issues, [_open, _closed]));
        case ('GET', '/api/v1/agents'):
        case ('GET', '/api/v1/skills'):
        case ('GET', '/api/v1/runtimes'):
          return jsonResponse([]);
        case ('GET', '/api/v1/sessions/w1'):
          return jsonResponse(_closed.toJson());
        case ('GET', '/api/v1/sessions/w1/events'):
          return jsonResponse([
            const SessionEvent(seq: 0, time: 0, type: SessionEventType.userMessage, text: '写打卡').toJson(),
            const SessionEvent(seq: 1, time: 5000, type: SessionEventType.assistantMessage, text: '打卡写好了').toJson(),
          ]);
        case ('POST', '/api/v1/issues'):
          final body = IssueRequest.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
          final item = Issue(
            id: 'a9',
            number: 1,
            title: body.title,
            project: body.project,
            assignee: body.assignee,
            priority: Priority.medium,
            createdAt: 2,
            sessions: const [],
            status: IssueStatus.backlog,
            moves: [],
          );
          issues = [item, ...issues];
          changed();
          return jsonResponse(item.toJson());
        case ('PUT', '/api/v1/issues/a2/move'):
          issues = [issues[1], issues[0], ...issues.skip(2)];
          changed();
          return jsonResponse([for (final i in issues) i.toJson()]);
        case ('PUT', '/api/v1/issues/a1/status'):
          issues = [
            for (final i in issues) i.id == 'a1' ? Issue.fromJson({...i.toJson(), 'queuedAt': 3, 'status': 'todo'}) : i,
          ];
          changed();
          return jsonResponse(issues.firstWhere((i) => i.id == 'a1').toJson());
        case ('PUT', '/api/v1/issues/t1/status'):
          return jsonResponse(
            Issue.fromJson({
              ...issues.last.toJson(),
              'status': 'in_progress',
              'sessions': ['w1', 'w3'],
            }).toJson(),
          );
      }
      return jsonResponse({'_tag': 'Missing', 'what': r.url.path}, 404);
    }).api;
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          apiProvider.overrideWithValue(api),
          _issuesNow.overrideWith(() => _Issues()..seed = issues),
          stateProvider.overrideWith((ref) => fakes.farm(issues: ref.watch(_issuesNow))),
          sideEventsProvider.overrideWith((ref) => const Stream<LiveEvent>.empty()),
        ],
        child: MaterialApp(
          theme: farmTheme(),
          home: const Scaffold(body: IssuesPage(id: 'w1')),
        ),
      ),
    );
    container = ProviderScope.containerOf(t.element(find.byType(IssuesPage)));
    await settle(t);
    for (final lane in ['待办', '处理中', '等你看', '已关']) {
      expect(find.text(lane), findsOneWidget);
    }
    expect(find.text('加日志'), findsOneWidget);
    expect(find.text('紧急'), findsOneWidget);
    expect(find.text('0 / 6 块地'), findsOneWidget);
    expect(find.textContaining('0 轮 · 开了'), findsOneWidget);
    expect(find.text('2 轮 · 用了 1 分 · ¥0.42'), findsOneWidget);

    await t.enterText(find.descendant(of: find.bySemanticsLabel('找工单'), matching: find.byType(EditableText)), '文案');
    await t.pump();
    expect(find.text('加日志'), findsNothing);
    expect(find.text('改文案'), findsOneWidget);
    expect(find.text('1 / 4 张'), findsOneWidget);
    await t.tap(find.text('清掉筛选'));
    await t.pump();
    expect(find.text('加日志'), findsOneWidget);

    await t.enterText(find.descendant(of: find.bySemanticsLabel('写一张待办'), matching: find.byType(EditableText)), '补测试');
    await t.testTextInput.receiveAction(TextInputAction.done);
    await settle(t);
    expect(writes.last, 'POST /api/v1/issues {"title":"补测试","project":"clock","assignee":"backend"}');
    expect(find.text('补测试'), findsOneWidget);

    Future<void> drag(Offset from, Offset to) async {
      final gesture = await t.startGesture(from);
      await gesture.moveBy(const Offset(10, 10));
      await t.pump();
      await gesture.moveTo(to);
      await t.pump();
      await gesture.up();
      await settle(t);
    }

    await drag(t.getCenter(find.text('改文案')), t.getCenter(find.text('加日志')));
    expect(writes.last, 'PUT /api/v1/issues/a2/move {"before":"a1"}');
    expect(find.text('2 轮 · 1 分 · 花了 ¥0.42'), findsOneWidget);
    expect(find.text('打卡写好了，测试全过'), findsOneWidget);

    final before = writes.length;
    await drag(t.getCenter(find.text('改文案')), t.getCenter(find.text('处理中')) + const Offset(0, 120));
    expect(writes.length, before);
    expect(toasts.toasts.first.title, '还差一点');

    await drag(t.getCenter(find.text('加日志')), t.getCenter(find.text('处理中')) + const Offset(0, 120));
    expect(writes.last, 'PUT /api/v1/issues/a1/status {"status":"todo"}');
    expect(toasts.toasts.first.title, '排上队了');
    expect(find.text('排队中'), findsOneWidget);

    await t.enterText(find.byType(EditableText).last, '打卡还要记时区');
    await t.pump();
    await t.tap(find.text('重开').last);
    await settle(t);
    expect(writes.last, 'PUT /api/v1/issues/t1/status {"status":"todo","text":"打卡还要记时区"}');
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 6));
  });
}
