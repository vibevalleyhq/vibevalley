import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/desk/tickets/tickets_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/tickets.dart';
import 'package:vibevalley/ui/kit/kit.dart' show toasts;
import 'package:shared_preferences/shared_preferences.dart';

import 'support/server.dart' show FakeServer, jsonResponse, settle;
import 'support/farm.dart' as fakes;

const _closed = TrajectoryHead(
  id: 'w1',
  name: '小吴',
  agent: 'backend',
  runtime: 'claude',
  project: 'clock',
  job: '写打卡\n细节在 README',
  startedAt: 0,
  endedAt: 60000,
  closed: IssueClose.merged,
  outcome: Outcome.completed,
  summary: '打卡写好了，测试全过',
  runs: 2,
  cny: 0.42,
);
const _open = TrajectoryHead(id: 'w2', name: '小郑', agent: 'frontend', project: 'clock', job: '改登录页', startedAt: 70000);

Issue _issue(
  String id,
  String text, {
  List<String> sessions = const [],
  IssueStatus status = IssueStatus.backlog,
  IssueClose? closed,
  String? parent,
  IssuePlan? plan,
}) => Issue(
  id: id,
  title: text,
  project: 'clock',
  assignee: 'backend',
  priority: Priority.medium,
  createdAt: 0,
  sessions: sessions,
  closedAt: closed == null ? null : 60000,
  closed: closed,
  parent: parent,
  plan: plan,
  status: status,
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

void main() {
  test("an issue for the manager: in 处理中 while the manager works on it, closed once it answered", () {
    const working = Issue(
      id: 't9',
      title: '看进度',
      assignee: managerAgent,
      priority: Priority.medium,
      createdAt: 0,
      sessions: [],
      status: IssueStatus.inProgress,
    );
    expect(isForManager(working), isTrue);
    expect(laneOf(working.status), Lane.working);
    const answered = Issue(
      id: 't9',
      title: '看进度',
      assignee: managerAgent,
      priority: Priority.medium,
      createdAt: 0,
      sessions: [],
      closedAt: 1,
      closed: IssueClose.answered,
      status: IssueStatus.done,
    );
    expect(ticketState(answered), TicketState.answered);
    expect(laneOf(answered.status), Lane.closed);
    expect(isForManager(_issue('t1', 'x')), isFalse);
  });

  test('a run in one line: what started it, how it went, how long, what it cost, what it heard', () {
    String took(double ms) => '${(ms / 60000).round()} 分钟';
    const done = Run(
      id: 1,
      session: 'w1',
      triggeredBy: RunTrigger(kind: RunTriggerKind.comment, message: 42),
      heard: [43, 44],
      startedAt: 0,
      endedAt: 180000,
      outcome: Outcome.completed,
      spent: Spent(tokens: 10, cny: 0.5),
    );
    expect(runText(done, 999999, took), '带话（#42） · 做完了 · 3 分钟 · ¥0.50 · 中途听到 2 句');
    const going = Run(
      id: 2,
      session: 'w1',
      triggeredBy: RunTrigger(kind: RunTriggerKind.schedule, missed: true),
      heard: [],
      startedAt: 0,
    );
    expect(runText(going, 120000, took), '定时（补跑） · 正在干 · 2 分钟');
    expect(runTriggerText(const RunTrigger(kind: RunTriggerKind.runtime)), '农机自己');
  });

  test("an issue's state: the server's status while open, how it closed after", () {
    expect(ticketState(_openIssue), TicketState.waiting);
    expect(ticketState(_issue('t3', 'x', sessions: ['w3'], status: IssueStatus.inProgress)), TicketState.working);
    expect(ticketState(_closedIssue), TicketState.harvested);
    expect(ticketState(_issue('t0', 'x', sessions: ['w0'], status: IssueStatus.canceled)), TicketState.closed);
    final step = _issue('p1.api', '写接口', sessions: ['w4'], status: IssueStatus.done, closed: IssueClose.mergedIntoPlan, parent: 'p1');
    expect(ticketState(step), TicketState.merged);
    expect(ticketPlanned(step, null), isTrue);
    const greet = Playbook(id: 'p1', title: '加 greet', goal: '加 greet', project: 'demo', state: PlaybookState.draft, nodes: [], parallel: 1, createdAt: 0);
    expect(ticketTitle(step, [greet]), '加 greet · 写接口');
    expect(ticketTitle(step), '写接口');
    expect(ticketTitle(_closedIssue), '写打卡');
    expect(ticketIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 'w1'), isTrue);
    expect(ticketIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 't5'), isTrue);
    expect(ticketIs(_issue('t5', 'x', sessions: ['w1', 'w6']), 'w2'), isFalse);
  });

  test('what dragging between lanes does', () {
    expect(moveOf(Lane.todo, Lane.working), Move.start);
    expect(moveOf(Lane.waiting, Lane.closed), Move.close);
    expect(moveOf(Lane.working, Lane.closed), Move.close);
    expect(moveOf(Lane.closed, Lane.working), Move.reopen);
    for (final (from, to) in [
      (Lane.todo, Lane.closed),
      (Lane.working, Lane.waiting),
      (Lane.waiting, Lane.todo),
      (Lane.closed, Lane.todo),
      (Lane.todo, Lane.todo),
    ]) {
      expect(moveOf(from, to), isNull, reason: '$from → $to');
    }
    expect(laneOf(IssueStatus.canceled), Lane.closed);
    expect(laneOf(IssueStatus.todo), Lane.todo);
    expect(moveOf(Lane.waiting, Lane.closed, planned: true), isNull);
    expect(moveOf(Lane.closed, Lane.working, planned: true), isNull);
    expect(ticketPlanned(_issue('t5', 'x', sessions: ['w5'], status: IssueStatus.done, closed: IssueClose.mergedIntoPlan), null), isTrue);
    expect(ticketPlanned(_closedIssue, null), isFalse);
  });

  testWidgets("a ticket whose harvest would conflict offers to have it solved, not to harvest; a planner's ticket reads as the playbook's", (t) async {
    t.view.physicalSize = const Size(1600, 1000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    SharedPreferences.setMockInitialValues({});
    final writes = <String>[];
    const conflicted = TrajectoryHead(id: 'w4', name: '省钱小工 2', agent: 'flash', project: 'demo', job: '改成 hey', startedAt: 0);
    const planner = TrajectoryHead(id: 'w5', name: '省钱小工', agent: 'flash', project: 'demo', job: '这一轮你是规划师：……', startedAt: 0, endedAt: 1);
    final issues = [
      _issue('t4', '改成 hey', sessions: ['w4'], status: IssueStatus.inReview),
      _issue(
        'p1',
        '加 greet',
        sessions: ['w5'],
        status: IssueStatus.inReview,
        plan: const IssuePlan(state: PlaybookState.draft, parallel: 1),
      ),
      _issue('p1.api', '写接口', parent: 'p1'),
    ];
    final api = FakeServer((r) async {
      if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
      return switch ((r.method, r.url.path)) {
        ('GET', '/api/sessions') => jsonResponse([conflicted.toJson(), planner.toJson()]),
        ('GET', '/api/agents') => jsonResponse([]),
        ('GET', '/api/sessions/w4') => jsonResponse(const Trajectory(head: conflicted, activities: []).toJson()),
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
          farmProvider.overrideWithValue(fakes.farm(sessions: [session], issues: issues)),
          plansProvider.overrideWithValue(const [
            Playbook(id: 'p1', title: '加 greet', goal: '加 greet', project: 'demo', state: PlaybookState.draft, nodes: [], parallel: 1, createdAt: 0),
          ]),
          sideEventsProvider.overrideWith((ref) => const Stream<SideEvent>.empty()),
        ],
        child: MaterialApp(
          theme: farmTheme(),
          home: const Scaffold(body: TicketsPage(id: 'w4')),
        ),
      ),
    );
    await settle(t);
    expect(find.text('收获'), findsNothing);
    expect(find.text('计划：加 greet'), findsOneWidget);
    expect(find.text('写接口'), findsNothing);
    await t.tap(find.text('让它解决冲突'));
    await settle(t);
    expect(writes.single, startsWith('POST /api/issues/tw4/resolve'));
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
        title: '加日志',
        project: 'clock',
        assignee: 'backend',
        priority: Priority.urgent,
        createdAt: 0,
        sessions: [],
        status: IssueStatus.backlog,
      ),
      const Issue(id: 'a2', title: '改文案', project: 'site', priority: Priority.medium, createdAt: 1, sessions: [], status: IssueStatus.backlog),
      _openIssue,
      _closedIssue,
    ];
    late ProviderContainer container;
    void changed() => container.read(_issuesNow.notifier).set(issues);
    final api = FakeServer((r) async {
      if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
      switch ((r.method, r.url.path)) {
        case ('GET', '/api/sessions'):
          return jsonResponse([_open.toJson(), _closed.toJson()]);
        case ('GET', '/api/agents'):
          return jsonResponse([]);
        case ('GET', '/api/sessions/w1'):
          return jsonResponse(
            const Trajectory(
              head: _closed,
              activities: [
                Activity(n: 0, at: 0, kind: ActivityKind.prompt, text: '写打卡'),
                Activity(n: 1, at: 5000, kind: ActivityKind.response, text: '打卡写好了'),
              ],
            ).toJson(),
          );
        case ('POST', '/api/issues'):
          final body = IssueRequest.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
          final item = Issue(
            id: 'a9',
            title: body.title,
            project: body.project,
            assignee: body.assignee,
            priority: Priority.medium,
            createdAt: 2,
            sessions: const [],
            status: IssueStatus.backlog,
          );
          issues = [item, ...issues];
          changed();
          return jsonResponse(item.toJson());
        case ('PUT', '/api/issues/a2/move'):
          issues = [issues[1], issues[0], ...issues.skip(2)];
          changed();
          return jsonResponse([for (final i in issues) i.toJson()]);
        case ('POST', '/api/issues/a1/start'):
          issues = [
            for (final i in issues) i.id == 'a1' ? Issue.fromJson({...i.toJson(), 'queuedAt': 3, 'status': 'todo'}) : i,
          ];
          changed();
          return jsonResponse(const Dispatched(queued: '已经有 6 个帮工在干活了：排上队了，有空地就自动开工').toJson());
        case ('POST', '/api/issues/t1/reopen'):
          return jsonResponse(const Dispatched(session: 'w3').toJson());
      }
      return jsonResponse({'_tag': 'Missing', 'what': r.url.path}, 404);
    }).api;
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          apiProvider.overrideWithValue(api),
          _issuesNow.overrideWith(() => _Issues()..seed = issues),
          farmProvider.overrideWith((ref) => fakes.farm(issues: ref.watch(_issuesNow))),
          sideEventsProvider.overrideWith((ref) => const Stream<SideEvent>.empty()),
        ],
        child: MaterialApp(
          theme: farmTheme(),
          home: const Scaffold(body: TicketsPage(id: 'w1')),
        ),
      ),
    );
    container = ProviderScope.containerOf(t.element(find.byType(TicketsPage)));
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
    expect(writes.last, 'POST /api/issues {"title":"补测试","project":"clock","assignee":"backend"}');
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
    expect(writes.last, 'PUT /api/issues/a2/move {"before":"a1"}');
    expect(find.text('2 轮 · 1 分 · 花了 ¥0.42'), findsOneWidget);
    expect(find.text('打卡写好了，测试全过'), findsOneWidget);

    final before = writes.length;
    await drag(t.getCenter(find.text('改文案')), t.getCenter(find.text('处理中')) + const Offset(0, 120));
    expect(writes.length, before);
    expect(toasts.toasts.first.title, '还差一点');

    await drag(t.getCenter(find.text('加日志')), t.getCenter(find.text('处理中')) + const Offset(0, 120));
    expect(writes.last, 'POST /api/issues/a1/start ');
    expect(toasts.toasts.first.title, '排上队了');
    expect(find.text('排队中'), findsOneWidget);

    await t.enterText(find.byType(EditableText).last, '打卡还要记时区');
    await t.pump();
    await t.tap(find.text('重开').last);
    await settle(t);
    expect(writes.last, 'POST /api/issues/t1/reopen {"text":"打卡还要记时区"}');
    await t.pumpWidget(const SizedBox.shrink());
    await t.pump(const Duration(seconds: 6));
  });
}
