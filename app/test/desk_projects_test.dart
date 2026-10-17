import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/projects/codebase.dart';
import 'package:vibevalley/desk/projects/projects_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'support/desk.dart';

LanguageCount lang(String name, double code, {double comments = 0, double files = 1}) =>
    LanguageCount(name: name, files: files, code: code, comments: comments, blanks: 0);

void main() {
  group('languages', () {
    test('aliases merge, shares add up, the tail becomes 其他', () {
      final shares = languageShares([
        lang('TypeScript', 600),
        lang('TSX', 200, comments: 100),
        lang('Rust', 50),
        lang('Python', 25),
        lang('Go', 10),
        lang('Shell', 5),
        lang('CSS', 4),
        lang('HTML', 3),
        lang('Zig', 2),
        lang('Lua', 1),
      ]);
      expect(shares.first.label, 'TypeScript');
      expect(shares.first.lines, 900);
      expect(shares.first.files, 2);
      expect(shares, hasLength(8));
      expect(shares.last.label, '其他');
      expect(shares.last.lines, 3);
      expect(shares.fold<double>(0, (n, s) => n + s.share), closeTo(1, 1e-9));
    });

    test('one leftover language keeps its name; unknown ones keep theirs', () {
      final shares = languageShares([lang('Go', 10), lang('Nim', 5)], top: 1);
      expect([for (final s in shares) s.label], ['Go', 'Nim']);
      expect(shares.last.id, 'other');
      expect(languageShares([lang('Go', 1)], top: null), hasLength(1));
    });
  });

  group('calendar', () {
    final now = DateTime(2026, 10, 14, 15); // a Wednesday
    test('53 weeks, Monday first, today in the last column and the days after it future', () {
      final c = calendarOf(const [], now);
      expect(c.weeks, hasLength(53));
      expect(c.weeks.first.first.at.weekday, DateTime.monday);
      final last = c.weeks.last;
      expect(last[2].day, '2026-10-14');
      expect(last[2].future, isFalse);
      expect(last[3].future, isTrue);
    });

    test('levels grow against the busy days; streaks count runs', () {
      final days = [
        const DayCount(day: '2026-10-14', commits: 8),
        const DayCount(day: '2026-10-13', commits: 2),
        const DayCount(day: '2026-10-12', commits: 1),
        const DayCount(day: '2026-10-08', commits: 4),
      ];
      final c = calendarOf(days, now);
      final today = c.weeks.last[2];
      expect(today.level, 4);
      expect(c.weeks.last[1].level, 1);
      final s = streaksOf(c);
      expect(s.total, 15);
      expect(s.days, 4);
      expect(s.longest, 3);
      expect(s.current, 3);
      expect(s.busiest, (day: '2026-10-14', commits: 8));
    });

    test('a month label over the week it starts in', () {
      final c = calendarOf(const [], now);
      expect(c.months.last.label, '10月');
      expect(c.weeks[c.months.last.week].any((d) => d.day == '2026-10-01'), isTrue);
    });
  });

  test('growth by the newest commit', () {
    const day = 86400000.0;
    expect(growthOf(null, 0).crop, 'empty');
    expect(growthOf(0, day / 2).label, '正旺');
    expect(growthOf(0, 5 * day).crop, 'leafy');
    expect(growthOf(0, 20 * day).crop, 'sprout');
    expect(growthOf(0, 60 * day).crop, 'dry');
    expect(growthOf(0, 200 * day).label, '荒了');
  });

  test('new projects: names and GitHub addresses', () {
    expect(githubRepository('https://github.com/botiverse/raft-source.git/'), (name: 'raft-source', url: 'https://github.com/botiverse/raft-source.git'));
    expect(githubRepository('git@github.com:a/b.git'), isNull);
    expect(githubRepository('https://github.com/a/..'), isNull);
    expect(number(1234567), '1,234,567');
    expect(since(0, 3 * 3600000), '3 小时前');
  });

  Routes backend() {
    final now = DateTime.now().millisecondsSinceEpoch;
    var list = [
      {'name': 'old', 'path': '/work/old', 'git': true, 'last': now - 200 * 86400000, 'slots': 3},
      {'name': 'farm', 'path': '/work/farm', 'git': true, 'last': now - 3600000, 'slots': 3},
      {'name': 'notes', 'path': '/work/notes', 'git': false, 'slots': 3},
    ];
    return Routes({
      'GET /api/projects': (_) => list,
      // The server's first check only: the rest of projectProblem is the Go's, tested there.
      'POST /api/projects/check': (Call c) => {if (((c.body! as Map)['name'] as String).startsWith('-')) 'problem': '项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符'},
      'GET /api/agents': (_) => [agentJson('a1', '阿郑', 'claude')],
      'GET /api/skills': (_) => <Object>[],
      'GET /api/runtimes': (_) => <Object>[],
      'GET /api/projects/farm/languages': (_) => {
        'project': 'farm',
        'at': now,
        'languages': [
          {'name': 'TypeScript', 'files': 10, 'code': 900, 'comments': 100, 'blanks': 5},
          {'name': 'Dart', 'files': 4, 'code': 300, 'comments': 0, 'blanks': 5},
        ],
      },
      'GET /api/projects/farm/activity': (_) => {
        'project': 'farm',
        'at': now,
        'days': [
          {'day': dayKey(DateTime.now()), 'commits': 3},
        ],
        'authors': [
          {'name': '阿郑', 'commits': 3},
          {'name': 'Lucas', 'commits': 1},
        ],
        'total': 42,
        'first': DateTime(2025, 3, 1).millisecondsSinceEpoch,
      },
      'POST /api/projects': (c) {
        final name = (c.body! as Map)['name'] as String;
        list = [
          ...list,
          {'name': name, 'path': '/work/$name', 'git': true, 'slots': 3},
        ];
        return {'name': name, 'path': '/work/$name', 'git': true, 'slots': 3};
      },
    });
  }

  testWidgets('the list, newest-worked first, and the selected project surveyed', (t) async {
    final b = backend();
    await pumpPage(t, const ProjectsPage(), b.handle);
    final names = [
      for (final n in ['farm', 'old', 'notes']) t.getTopLeft(find.text(n).first).dy,
    ];
    expect(names, orderedEquals([...names]..sort()));
    expect(find.text('还不是 git 仓库'), findsOneWidget);
    expect(b.named('GET', '/api/projects/farm/languages'), hasLength(1));
    expect(find.text('1,300 行'), findsOneWidget);
    expect(find.text('2 样'), findsOneWidget);
    expect(find.text('42 次提交'), findsOneWidget);
    expect(find.text('2025 年 3 月 1 日'), findsOneWidget);
    expect(find.text('77%'), findsOneWidget);
    // The detail scrolls on its own: drag from inside it.
    await t.drag(find.text('42 次提交'), const Offset(0, -3000));
    await t.pump();
    expect(find.text('Lucas'), findsOneWidget);
    expect(find.text('3 次'), findsOneWidget);
  });

  testWidgets('新增项目: the name follows the GitHub address; a bad one is refused before it is made', (t) async {
    final b = backend();
    await pumpPage(t, const ProjectsPage(), b.handle);
    await t.tap(find.text('新增项目'));
    await t.pump();
    await t.enterText(find.bySemanticsLabel('GitHub 地址').last, 'https://github.com/botiverse/raft-source');
    await t.pump();
    expect(find.text('raft-source'), findsWidgets);
    await t.tap(find.text('开一块新地'));
    await t.pump();
    await t.enterText(find.bySemanticsLabel('项目名').last, '-no');
    await t.pump();
    await t.tap(find.text('创建项目'));
    await settle(t);
    expect(find.text('项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符'), findsOneWidget);
    expect(b.named('POST', '/api/projects'), isEmpty);
    await t.enterText(find.bySemanticsLabel('项目名').last, 'patch');
    await t.pump();
    await t.tap(find.text('创建项目'));
    await settle(t);
    await settle(t); // the check, then the making, then the dialog closing
    expect(b.named('POST', '/api/projects').single.body, {'name': 'patch'});
    expect(find.text('创建项目'), findsNothing);
    expect(find.text('patch'), findsOneWidget);
  });
}
