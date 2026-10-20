import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/issues/issues_page.dart';

import '../support/farm.dart' as fakes;
import '../support/workbench.dart';

Issue _issue(String id, String title, {String? project, String? assignee, IssueStatus status = IssueStatus.backlog, IssueClose? closed}) => Issue(
  id: id,
  number: 7,
  title: title,
  project: project,
  assignee: assignee,
  priority: Priority.medium,
  createdAt: 0,
  sessions: const [],
  closedAt: closed == null ? null : 1,
  closed: closed,
  status: status,
  moves: const [],
  acceptance: Acceptance.glance,
  findings: const [],
  asks: const [],
);

void main() {
  testWidgets('列表 shows rows grouped by status, folds a group, groups by project from 显示, and 看板 switches back', (t) async {
    SharedPreferences.setMockInitialValues({});
    final issues = [
      _issue('a1', '加日志', project: 'clock'),
      _issue('a2', '改文案', project: 'site'),
      _issue('m1', '理一理本周', assignee: managerAgent, status: IssueStatus.inProgress),
      _issue('m2', '回答问题', assignee: managerAgent, status: IssueStatus.done, closed: IssueClose.answered),
    ];
    final writes = <String>[];
    final backend = WorkbenchBackend();
    await pumpPage(t, const IssuesPage(), (r) async {
      if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
      return switch ((r.method, r.url.path)) {
        ('GET', '/api/v1/issues/history') => jsonResponse([
          for (final i in issues) IssueHistory(issue: i, sessions: const [], missingSessions: const []).toJson(),
        ]),
        ('POST', '/api/v1/issues') => jsonResponse(_issue('a9', '补测试', project: 'site').toJson()),
        ('POST', '/api/v1/issues/a9/draft') => jsonResponse(_issue('a9', '补测试', project: 'site').toJson()),
        _ => backend.handle(r),
      };
    }, farm: fakes.farm(issues: issues));

    // The board is the default: four lanes with the pencil and the quick add on 待办.
    expect(find.bySemanticsLabel('写一张待办'), findsOneWidget);
    await t.tap(find.text('列表'));
    await settle(t);
    expect(find.bySemanticsLabel('写一张待办'), findsNothing, reason: 'the list has no lanes');
    double y(String text) => t.getTopLeft(find.text(text)).dy;
    for (final lane in ['待办', '处理中', '等你看', '已关']) {
      expect(find.text(lane), findsOneWidget);
    }
    expect(y('待办') < y('加日志') && y('加日志') < y('处理中'), isTrue);
    expect(y('处理中') < y('理一理本周') && y('理一理本周') < y('等你看'), isTrue);
    expect(y('已关') < y('回答问题'), isTrue);
    expect(find.text('#7'), findsNWidgets(4), reason: 'every row says its number');
    expect((await SharedPreferences.getInstance()).getStringList('vibevalley.board.look'), ['list', 'status', 'manual']);

    // A group folds under its header.
    await t.tap(find.text('待办'));
    await settle(t);
    expect(find.text('加日志'), findsNothing);
    await t.tap(find.text('待办'));
    await settle(t);
    expect(find.text('加日志'), findsOneWidget);

    // 显示 → 项目: a group per project, the rows without one last; the group's plus writes into that project.
    await t.tap(find.text('显示'));
    await settle(t);
    await t.tap(find.text('项目'));
    await settle(t);
    await t.tapAt(const Offset(20, 1100));
    await settle(t);
    expect(find.text('项目'), findsNothing, reason: 'the panel closes on a tap outside');
    expect(y('clock') < y('加日志') && y('加日志') < y('site') && y('site') < y('改文案') && y('改文案') < y('没有项目'), isTrue);
    await t.tap(find.bySemanticsLabel('在「site」写一张'));
    await settle(t);
    await t.enterText(find.descendant(of: find.bySemanticsLabel('写一张待办'), matching: find.byType(EditableText)), '补测试');
    await t.testTextInput.receiveAction(TextInputAction.done);
    await settle(t);
    expect(writes, contains('POST /api/v1/issues {"title":"补测试","project":"site"}'));

    await t.tap(find.text('看板'));
    await settle(t);
    expect(find.bySemanticsLabel('写一张待办'), findsOneWidget);
    expect((await SharedPreferences.getInstance()).getStringList('vibevalley.board.look'), ['board', 'project', 'manual']);
    await t.pumpWidget(const SizedBox.shrink());
  });
}
