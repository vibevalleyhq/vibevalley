import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/issues.dart';
import 'package:vibevalley/shared/harvest_rules.dart';
import 'package:vibevalley/shared/issue_state.dart';
import 'package:vibevalley/ui/theme.dart';

import '../support/farm.dart' as f;

Issue _issue({
  IssueStatus status = IssueStatus.inReview,
  List<IssueStatus> moves = const [IssueStatus.todo, IssueStatus.done, IssueStatus.canceled],
  List<String> asks = const [],
  List<Finding> findings = const [],
  double? acceptedAt,
  double? closedAt,
  IssueClose? closed,
  String? parent,
}) => Issue(
  id: 'tw1',
  number: 1,
  title: '加日志',
  project: 'demo',
  priority: Priority.medium,
  createdAt: 0,
  status: status,
  sessions: const ['w1'],
  moves: moves,
  acceptance: Acceptance.glance,
  findings: findings,
  asks: asks,
  acceptedAt: acceptedAt,
  closedAt: closedAt,
  closed: closed,
  parent: parent,
);

const _ripe = PhaseRipe();
const _done = LastRun(outcome: Outcome.completed, summary: '做好了', at: 1000);

IssueState _state(Issue? issue, Session? session, {IssueTag? tag, List<Session>? sessions, List<TaskGraph> graphs = const []}) => IssueState.of(
  issue: issue,
  sessions: sessions ?? [?session],
  tag: tag ?? (issue == null ? IssueTag.waiting : issueTag(issue)),
  session: session,
  graphs: graphs,
);

List<IssueAct> _acts(IssueState s) => [for (final o in s.offers) o.act];

void main() {
  test('what can be done follows the state, and every act is offered somewhere', () {
    final waiting = _state(_issue(), f.session('w1', phase: _ripe, last: _done));
    expect(waiting.offers, [(act: IssueAct.harvest, lead: true), (act: IssueAct.close, lead: false)]);

    final working = _state(_issue(status: IssueStatus.inProgress), f.session('w1'));
    expect(_acts(working), [IssueAct.stop, IssueAct.close]);

    final conflict = _state(
      _issue(),
      f.session(
        'w1',
        phase: _ripe,
        last: _done,
        conflict: const Conflict(base: 'main', files: ['a.ts']),
      ),
    );
    expect(conflict.offers.first, (act: IssueAct.resolve, lead: true));

    final halfway = _state(
      _issue(),
      f.session(
        'w1',
        phase: _ripe,
        last: const LastRun(outcome: Outcome.interrupted, summary: '', at: 1),
      ),
    );
    expect(halfway.offers, [(act: IssueAct.resume, lead: true), (act: IssueAct.harvest, lead: false), (act: IssueAct.close, lead: false)]);

    final failed = _state(
      _issue(),
      f.session(
        'w1',
        phase: _ripe,
        last: const LastRun(outcome: Outcome.failed, summary: '', at: 1),
      ),
    );
    expect(_acts(failed), [IssueAct.cure, IssueAct.close]);

    // A required acceptance not yet passed: the server leaves done out of moves, so no harvest.
    final unaccepted = _state(_issue(moves: const [IssueStatus.todo, IssueStatus.canceled]), f.session('w1', phase: _ripe, last: _done));
    expect(_acts(unaccepted), [IssueAct.close]);

    final closed = _state(
      _issue(status: IssueStatus.done, closed: IssueClose.merged, closedAt: 0),
      null,
      sessions: [f.session('w1', phase: _ripe)],
    );
    expect(closed.offers, isEmpty);

    final step = _state(_issue(parent: 'g1'), f.session('w1', phase: _ripe, last: _done));
    expect(step.offers, isEmpty, reason: "a task's step goes with its task");

    final offered = {
      for (final s in [waiting, working, conflict, halfway, failed]) ..._acts(s),
    };
    expect(offered, IssueAct.values.toSet());
  });

  test('the status line says what is going on first', () {
    final asked = _state(_issue(asks: const ['用哪个库？']), f.session('w1', phase: _ripe, last: _done));
    expect(asked.status.head, '缺肥：小吴在等你回答');
    expect(asked.status.list, ['用哪个库？']);

    final conflict = _state(
      _issue(),
      f.session(
        'w1',
        phase: _ripe,
        last: _done,
        conflict: const Conflict(base: 'main', files: ['a.ts', 'b.ts']),
      ),
    );
    expect((conflict.status.head, conflict.status.line, conflict.status.tone), ('合进 main 会冲突', 'a.ts、b.ts', Palette.berry));

    final working = _state(_issue(status: IssueStatus.inProgress), f.session('w1'));
    expect(working.status.head, '小吴 正在改文件（第 1 轮）');
    expect(working.status.line, 'src/a.ts');
    expect(working.showsDoing, isTrue);

    final waiting = _state(_issue(), f.session('w1', phase: _ripe, last: _done));
    expect((waiting.status.head, waiting.status.line), ('等你验收 · 小吴交回来了（第 1 轮）', '做好了'));

    final accepted = _state(_issue(acceptedAt: 1), f.session('w1', phase: _ripe, last: _done));
    expect(accepted.status.head, '验收过了，可以收获');

    final closed = _state(
      _issue(status: IssueStatus.done, closed: IssueClose.merged),
      null,
      sessions: [f.session('w1', phase: _ripe, last: _done)],
    );
    expect(closed.status.head, '已收获');
  });

  test('the box judges, talks or reopens', () {
    final judging = _state(_issue(), f.session('w1', phase: _ripe, last: _done));
    expect((judging.judging, judging.talking, judging.reopening, judging.enterSends), (true, true, false, false));
    expect(judging.placeholder, '没过就写哪里要修，一行一条；也可以只带句话');
    expect(judging.boxLabel, '给小吴带句话');

    final working = _state(_issue(status: IssueStatus.inProgress), f.session('w1'));
    expect((working.judging, working.talking, working.enterSends), (false, true, true));
    expect(working.placeholder, '干着活也能收到这句话');

    final accepted = _state(_issue(acceptedAt: 1), f.session('w1', phase: _ripe, last: _done));
    expect(accepted.judging, isFalse, reason: 'judged already');

    final closed = _state(
      _issue(status: IssueStatus.done, closed: IssueClose.merged),
      null,
      sessions: [f.session('w1', phase: _ripe)],
    );
    expect((closed.talking, closed.reopening, closed.hasBox), (false, true, true));
    expect(closed.boxLabel, '重开这张工单');

    final step = _state(
      _issue(status: IssueStatus.done, parent: 'g1'),
      null,
      sessions: [f.session('w1', phase: _ripe)],
    );
    expect(step.reopening, isFalse);
    expect(step.inTask, isTrue);
    expect(step.taskText, '这是种植计划里的一步，跟着计划走。');
  });

  test('the crew is each helper once; the hoe is with the one on the plot', () {
    final first = f.session('w0', name: '老王', agent: 'a');
    final again = f.session('w2', name: '老王二', agent: 'a');
    final now = f.session('w1', agent: 'b', phase: _ripe, last: _done, worktree: '/w');
    final s = _state(_issue(), now, sessions: [first, again, now]);
    expect([for (final c in s.crew) c.id], ['w0', 'w1']);
    expect(s.crewLine, '老王、小吴 · 锄头在小吴手上');
    expect(s.historyLine, '3 次：老王（w0） → 老王二（w2） → 小吴（w1）');
    expect(_state(_issue(), f.session('w1', phase: _ripe)).crewLine, isNull);
  });

  test('weeds and their findings', () {
    final s = _state(
      _issue(
        findings: const [
          Finding(id: 'a', text: '少测试', at: 0),
          Finding(id: 'b', text: '旧接口', at: 0, pulled: true),
        ],
      ),
      f.session('w1', phase: _ripe, last: _done),
    );
    expect([for (final w in s.weeds) w.text], ['少测试']);
    expect([for (final w in s.pulled) w.text], ['旧接口']);
    expect(findingsOf(' 看板还在调旧接口 \n\n少一个测试\n'), ['看板还在调旧接口', '少一个测试']);
  });

  test('changes read as one line, binary files not counted in the harvest', () {
    const c = Changes(
      project: 'demo',
      base: 'main',
      branch: 'vv/1',
      commits: [Commit(hash: 'abc', subject: 'x', at: 0)],
      files: [
        ChangedFile(path: 'a.ts', status: 'M', added: 3, removed: 1),
        ChangedFile(path: 'b.png', status: 'A', added: -1, removed: -1),
      ],
      uncommitted: [],
      conflicts: [],
      behind: 0,
    );
    expect(changesLine(c), 'vv/1 → main · 1 个提交 · +2 -0');
    expect(lineCounts(c), (3, 1));
    expect(nothingChanged(c), isFalse);
    expect(changeKind('D'), (mark: '删', label: '删除'));
    expect(patchLines('diff\n--- a\n@@ -1 +1 @@\n-x\n+y'), ['@@ -1 +1 @@', '-x', '+y']);
    expect([for (final l in patchLines('@@\n-x\n+y\n z')) patchMarkOf(l)], [PatchMark.hunk, PatchMark.removed, PatchMark.added, PatchMark.plain]);
  });
}
