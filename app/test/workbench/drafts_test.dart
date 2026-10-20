import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/ui/pro/pro.dart' show ProButton;
import 'package:vibevalley/ui/pixel/theme.dart';
import 'package:vibevalley/workbench/issues/issue_detail.dart' show TodoDetail;
import 'package:vibevalley/workbench/issues/issues_page.dart';

import '../support/farm.dart' as fakes;
import '../support/workbench.dart' show FakeServer, atlas, jsonResponse, settle;

Issue _draft(
  String id,
  String title, {
  String? description,
  List<String>? criteria,
  List<String> asks = const [],
  IssueDrafting? drafting,
  String? assignee = 'backend',
}) => Issue(
  id: id,
  number: 7,
  title: title,
  description: description,
  project: 'clock',
  assignee: assignee,
  priority: Priority.medium,
  createdAt: 0,
  sessions: const [],
  status: IssueStatus.backlog,
  moves: drafting == null ? const [IssueStatus.todo, IssueStatus.canceled] : const [IssueStatus.canceled],
  acceptance: Acceptance.glance,
  findings: const [],
  asks: asks,
  criteria: criteria,
  drafting: drafting,
);

class _Issues extends Notifier<List<Issue>> {
  List<Issue> seed = const [];
  @override
  List<Issue> build() => seed;
  void set(List<Issue> issues) => state = issues;
}

final _issuesNow = NotifierProvider<_Issues, List<Issue>>(_Issues.new);

/// The board under a router, as the workbench has it: a link to an issue opens its detail.
class _Board {
  _Board(this.t, List<Issue> issues, {required this.answer}) : issues = [...issues];
  final WidgetTester t;
  List<Issue> issues;
  final Object? Function(String method, String path, Map<String, dynamic>? body) answer;
  final writes = <String>[];
  late ProviderContainer container;
  late GoRouter router;

  void changed(List<Issue> next) {
    issues = next;
    container.read(_issuesNow.notifier).set(issues);
  }

  Future<void> pump(String at) async {
    t.view.physicalSize = const Size(1600, 1200);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final server = FakeServer((r) async {
      final body = r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>?;
      // agent.check is a question, though a POST.
      if (r.method != 'GET' && r.url.path != '/api/v1/agents/check') writes.add('${r.method} ${r.url.path} ${r.body}');
      if (r.method == 'GET' && r.url.path == '/api/v1/issues/history') {
        return jsonResponse([for (final i in issues) IssueHistory(issue: i, sessions: const [], missingSessions: const []).toJson()]);
      }
      final got = answer(r.method, r.url.path, body);
      return got == null ? jsonResponse([]) : jsonResponse(got);
    });
    router = GoRouter(
      initialLocation: at,
      routes: [
        GoRoute(
          path: '/issues',
          builder: (_, _) => const Scaffold(body: IssuesPage()),
        ),
        GoRoute(
          path: '/issues/:id',
          builder: (_, s) => Scaffold(body: IssuesPage(id: s.pathParameters['id'])),
        ),
      ],
    );
    addTearDown(router.dispose);
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          serverProvider.overrideWithValue(server),
          _issuesNow.overrideWith(() => _Issues()..seed = issues),
          stateProvider.overrideWith((ref) => fakes.farm(issues: ref.watch(_issuesNow))),
          sideEventsProvider.overrideWith((ref) => const Stream<LiveEvent>.empty()),
          atlasProvider.overrideWith((ref) async => atlas),
        ],
        child: MaterialApp.router(theme: farmTheme(), routerConfig: router),
      ),
    );
    container = ProviderScope.containerOf(t.element(find.byType(IssuesPage)));
    await settle(t);
  }
}

Finder _box(String label) => find.descendant(of: find.bySemanticsLabel(label), matching: find.byType(EditableText)).first;

ProButton _button(WidgetTester t, String text) => t.widget<ProButton>(find.widgetWithText(ProButton, text));

void main() {
  testWidgets('the plus makes the issue at once from its sentence, starts its draft and opens it', (t) async {
    SharedPreferences.setMockInitialValues({
      'vibevalley.board.pick': ['', 'clock'],
    });
    late _Board board;
    board = _Board(
      t,
      const [],
      answer: (method, path, body) {
        switch ((method, path)) {
          case ('POST', '/api/v1/issues'):
            final made = _draft('n1', body!['title'] as String, assignee: null);
            board.changed([made, ...board.issues]);
            return made.toJson();
          case ('POST', '/api/v1/issues/n1/draft'):
            final drafting = _draft(
              'n1',
              '看板拖卡还在调旧接口',
              drafting: const IssueDrafting(session: 'w5', name: '小吴'),
              assignee: 'backend',
            );
            board.changed([drafting]);
            return drafting.toJson();
        }
        return null;
      },
    );
    await board.pump('/issues');
    await t.enterText(_box('写一张待办'), '看板拖卡还在调旧接口');
    await t.testTextInput.receiveAction(TextInputAction.done);
    await settle(t);
    expect(board.writes, ['POST /api/v1/issues {"title":"看板拖卡还在调旧接口","project":"clock"}', 'POST /api/v1/issues/n1/draft {"text":"看板拖卡还在调旧接口"}']);
    expect(board.router.state.uri.path, '/issues/n1', reason: 'it opens at once');
    expect(find.byType(TodoDetail), findsOneWidget);
    expect(find.text('小吴在起草'), findsNWidgets(2), reason: 'the detail and the card say who drafts it');
    expect(_button(t, '开工').onPressed, isNull, reason: 'not sent while it drafts');
    expect(_button(t, '起草').onPressed, isNull, reason: 'one draft at a time');
  });

  testWidgets('派一件活 without words makes an empty issue in the project and opens it on its box', (t) async {
    SharedPreferences.setMockInitialValues({});
    late _Board board;
    board = _Board(
      t,
      const [],
      answer: (method, path, body) {
        switch ((method, path)) {
          case ('POST', '/api/v1/issues'):
            final made = _draft('n2', body!['title'] as String, assignee: null);
            board.changed([made]);
            return made.toJson();
          case ('POST', '/api/v1/issues/n2/draft'):
            return _draft(
              'n2',
              body!['text'] as String,
              drafting: const IssueDrafting(session: 'w6', name: '小郑'),
            ).toJson();
        }
        return null;
      },
    );
    await board.pump('/issues');
    final context = t.element(find.byType(IssuesPage));
    await writeIssueAndOpen(context, board.container.read(apiProvider), project: 'clock');
    await settle(t);
    expect(board.writes, ['POST /api/v1/issues {"title":"新工单","project":"clock"}'], reason: 'no draft without words');
    expect(board.router.state.uri.path, '/issues/n2');
    expect(find.text('想做什么？'), findsOneWidget);
    expect(_button(t, '起草').onPressed, isNull, reason: 'nothing to draft from yet');
    await t.enterText(_box('想做什么'), '给登录页加上记住我');
    await t.pump();
    await t.tap(find.widgetWithText(ProButton, '起草'));
    await settle(t);
    expect(board.writes.last, 'POST /api/v1/issues/n2/draft {"text":"给登录页加上记住我"}');
  });

  testWidgets('the 待办 pencil makes an empty issue and opens it, not an issue called new', (t) async {
    SharedPreferences.setMockInitialValues({});
    late _Board board;
    board = _Board(
      t,
      const [],
      answer: (method, path, body) {
        if ((method, path) == ('POST', '/api/v1/issues')) {
          final made = _draft('n3', body!['title'] as String, assignee: null);
          board.changed([made]);
          return made.toJson();
        }
        return null;
      },
    );
    await board.pump('/issues');
    await t.tap(find.bySemanticsLabel('详细写一张'));
    await settle(t);
    expect(board.writes, ['POST /api/v1/issues {"title":"新工单"}']);
    expect(board.router.state.uri.path, '/issues/n3');
    expect(find.text('找不到这张工单'), findsNothing);
    expect(find.text('想做什么？'), findsOneWidget);
  });

  testWidgets('a draft shows its fields and questions; the box answers them; 开工 sends it with its criteria', (t) async {
    SharedPreferences.setMockInitialValues({});
    final drafted = _draft('d1', '看板拖卡改用 issue.status', description: '为什么：\n看板还在调旧接口', criteria: ['拖到待办就开工'], asks: ['用 8787 还是 8797？']);
    late _Board board;
    board = _Board(
      t,
      [drafted],
      answer: (method, path, body) => switch ((method, path)) {
        ('POST', '/api/v1/issues/d1/draft') => drafted.toJson(),
        ('PUT', '/api/v1/issues/d1') => drafted.toJson(),
        ('PUT', '/api/v1/issues/d1/status') => Issue.fromJson({
          ...drafted.toJson(),
          'status': 'in_progress',
          'sessions': ['w1'],
        }).toJson(),
        _ => null,
      },
    );
    await board.pump('/issues/d1');
    expect(find.text('草稿'), findsNWidgets(2), reason: 'the detail and its card');
    for (final text in ['草稿写好了，它有 1 个问题要问你', '· 用 8787 还是 8797？', '看板拖卡改用 issue.status', '再起草', '开工']) {
      expect(find.text(text), findsWidgets, reason: text);
    }
    expect(find.text('1 条 · 拖到待办就开工'), findsOneWidget, reason: 'written criteria fold to their count and first line');
    await t.enterText(_box('想做什么'), '用 8797');
    await t.pump();
    await t.tap(find.widgetWithText(ProButton, '再起草'));
    await settle(t);
    expect(board.writes.last, 'POST /api/v1/issues/d1/draft {"text":"用 8797"}', reason: 'the word answers what it asked');

    await t.tap(find.text('验收标准'));
    await settle(t);
    await t.enterText(_box('验收标准'), '拖到待办就开工\n\n端口是 8797');
    await t.pump();
    await t.tap(find.widgetWithText(ProButton, '开工'));
    await settle(t);
    final update = board.writes.lastWhere((w) => w.startsWith('PUT /api/v1/issues/d1 '));
    expect(jsonDecode(update.substring('PUT /api/v1/issues/d1 '.length))['criteria'], ['拖到待办就开工', '端口是 8797'], reason: 'the edited criteria, one a line');
    expect(board.writes.last, 'PUT /api/v1/issues/d1/status {"status":"todo"}');
  });
}
