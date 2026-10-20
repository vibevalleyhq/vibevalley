// An issue's page, as decisions: what it says first, what can be done, what the box is for. The farm (shared/issue_view.dart)
// and the workbench (workbench/issues/issue_panel.dart) each draw it; neither decides any of it.

import 'dart:ui' show Color;

import '../data/remote.dart' show SessionEnd;
import '../gen/vibevalley.dart';
import '../rules/issues.dart';
import '../rules/rounds.dart';
import '../rules/sessions.dart';
import '../rules/task.dart';
import '../rules/time.dart';
import '../ui/theme.dart';

/// What can be done to an issue from its page. Every view draws each (the test walks `IssueAct.values`).
enum IssueAct {
  /// 叫停这一轮
  stop,

  /// 让它解决冲突
  resolve,

  /// 接着做: a round stopped halfway goes on.
  resume,

  /// 收获
  harvest,

  /// 接着修
  cure,

  /// 关上
  close,
}

/// `lead` is the one the page leads with (the primary button).
typedef IssueOffer = ({IssueAct act, bool lead});

/// What is going on, in one line and what it needs: the first thing the owner reads. `tone` is from the palette.
typedef IssueStatusLine = ({String head, String? line, List<String> list, Color tone});

/// The message 接着做 sends to a round that stopped halfway.
const resumeWords = '上一轮停在了半路，接着把它做完。';

class IssueState {
  IssueState._({
    required this.issue,
    required this.sessions,
    required this.tag,
    required this.session,
    required this.head,
    required this.inTask,
    required this.current,
    required this.title,
    required this.description,
    required this.project,
    required this.taskText,
  });

  /// `sessions` oldest first; `session` the one on the farm now, if any.
  factory IssueState.of({
    required Issue? issue,
    required List<Session> sessions,
    required IssueTag tag,
    required Session? session,
    List<TaskGraph> graphs = const [],
  }) {
    final head = session ?? sessions.last;
    final graphTag = head.graph;
    final graphId = graphTag?.id ?? issue?.parent ?? (issue?.graph != null ? issue?.id : null);
    final graph = graphId == null ? null : graphOf(graphs, graphId);
    final node = graphTag?.task == null || graph == null ? null : taskOf(graph, graphTag!.task!);
    return IssueState._(
      issue: issue,
      sessions: sessions,
      tag: tag,
      session: session,
      head: head,
      inTask: issue != null ? issueInTask(issue, session) : session?.graph != null,
      current: doingOf(head),
      title: issue == null ? head.brief : issueTitle(issue, graphs),
      description: issue?.description?.isNotEmpty == true ? issue!.description! : head.brief,
      project: issue?.project ?? head.project,
      taskText: graph == null
          ? '这是种植计划里的一步，跟着计划走。'
          : node == null
          ? '在拆种植计划「${graph.title}」：只读代码，不改文件。'
          : '种植计划「${graph.title}」的一步：${node.title}。做完自动合进计划分支，收获整个计划时才进主分支。',
    );
  }

  final Issue? issue;

  /// Oldest first.
  final List<Session> sessions;
  final IssueTag tag;
  final Session? session;

  /// The session the page is about: the one on the farm, else the last.
  final Session head;

  /// A task's step has no actions of its own: it goes with its task.
  final bool inTask;
  final Doing current;
  final String title;
  final String description;
  final String? project;
  final String taskText;
  bool get open => tag.open;

  /// The weeds still to pull, and the pulled.
  List<Finding> get weeds => issue?.findings.where((f) => f.pulled != true).toList() ?? const [];
  List<Finding> get pulled => issue?.findings.where((f) => f.pulled == true).toList() ?? const [];

  /// While it is judged, the verdict goes with the box: 没过 sends what it says as the findings.
  bool get judging {
    final i = issue;
    final s = session;
    return i != null &&
        !inTask &&
        tag == IssueTag.waiting &&
        s != null &&
        s.conflict == null &&
        i.acceptedAt == null &&
        head.lastRun?.outcome != Outcome.failed;
  }

  /// The box carries a word to the session on the farm.
  bool get talking => open && session != null;

  /// The box says what a reopened issue is for.
  bool get reopening => !open && issue != null && !inTask;

  bool get hasBox => talking || reopening;

  /// Enter starts a line while it is judged: 没过 reads the box one finding a line.
  bool get enterSends => !judging;

  String get placeholder => judging
      ? '没过就写哪里要修，一行一条；也可以只带句话'
      : reopening
      ? '这次要它做什么（不填就是接着做完）'
      : session?.phase is PhaseWorking
      ? '干着活也能收到这句话'
      : '说一句，它接着做一轮';

  String get boxLabel => reopening ? '重开这张工单' : '给${head.name}带句话';

  /// A task's step goes with its task's acceptance; the row's buttons work only while the issue is open.
  bool get acceptanceEditable => issue != null && !inTask;

  /// Each helper once, the first time it worked the issue.
  List<Session> get crew => [
    for (final s in sessions)
      if (!sessions.takeWhile((x) => x != s).any((x) => x.agent == s.agent)) s,
  ];

  /// 地上的人: who has worked the plot, and who holds the hoe; null when there is only one and no worktree.
  String? get crewLine {
    final hand = head.worktree != null ? session : null;
    if (crew.length <= 1 && hand == null) return null;
    return [
      crew.map((c) => c.name).join('、'),
      // One plot, one worktree: only the session on it now changes the code.
      if (hand != null) '锄头在${hand.name}手上',
    ].join(' · ');
  }

  String get whoLine => '${head.name}${head.runtime.isNotEmpty ? '（${head.runtime}）' : ''}';

  String get historyLine => '${sessions.length} 次：${sessions.map((r) => '${r.name}（${r.id}）').join(' → ')}';

  /// 用时: rounds, time, money, tokens.
  String usedLine({required List<SessionEvent> steps, required double now}) {
    final s = session ?? head;
    final turns = s.runs;
    final cny = s.spent?.cny;
    return [
      '${turns > 0 ? turns.round() : roundsOf(steps).length} 轮',
      tookText((head.endedAt ?? now) - head.hiredAt),
      if (cny != null) '花了 ¥${cny.toStringAsFixed(2)}',
      if (head.spent case final spent? when spent.tokens > 0) '${spent.tokens.round()} token',
    ].join(' · ');
  }

  /// The runs card reads again when this changes.
  String get runsVersion => '$tag:${session?.runs}:${session?.phase.runtimeType}';

  /// The issue's changes are worth reading while it waits to be looked at.
  bool get showsChanges => tag == IssueTag.waiting && session != null && issue != null;

  /// What can be done now, in the order the page shows them.
  List<IssueOffer> get offers {
    if (inTask) return const [];
    return switch ((tag, session)) {
      (IssueTag.working, _?) => const [(act: IssueAct.stop, lead: false), (act: IssueAct.close, lead: false)],
      (IssueTag.waiting, final h?) when h.conflict != null => const [(act: IssueAct.resolve, lead: true), (act: IssueAct.close, lead: false)],
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
      (IssueTag.waiting, final h?) when h.lastRun?.outcome == Outcome.interrupted => const [
        (act: IssueAct.resume, lead: true),
        (act: IssueAct.harvest, lead: false),
        (act: IssueAct.close, lead: false),
      ],
      (IssueTag.waiting, final h?) => [
        // Every issue has an acceptance; the server leaves done out of moves until a required one has passed.
        if (h.lastRun?.outcome != Outcome.failed && (issue?.moves.contains(IssueStatus.done) ?? true)) (act: IssueAct.harvest, lead: true),
        if (h.lastRun?.outcome == Outcome.failed) (act: IssueAct.cure, lead: true),
        (act: IssueAct.close, lead: false),
      ],
      _ => const [],
    };
  }

  IssueStatusLine get status {
    final phase = head.phase;
    final who = head.name;
    final round = head.runs > 0 ? '第 ${head.runs.round()} 轮' : null;
    final summary = head.lastRun?.summary;
    final asks = issue?.asks ?? const <String>[];
    if (asks.isNotEmpty && session != null) {
      return (head: '缺肥：$who在等你回答', line: '在下面说一句就算回答。', list: asks, tone: Palette.wheat);
    }
    if (session?.conflict case final conflict?) {
      return (head: '合进 ${conflict.base} 会冲突', line: conflict.files.join('、'), list: const [], tone: Palette.berry);
    }
    switch (tag) {
      case IssueTag.working:
        final doing = current.action == SessionAction.none ? '在干活' : '正在${current.actionText ?? ''}';
        final quiet = phase is PhaseWorking && phase.quietSince != null;
        return (
          head: '$who $doing${round == null ? '' : '（$round）'}',
          line: quiet ? '很久没动静：可能在跑很久的命令，也可能卡住了。' : (current.label.isEmpty ? null : current.label),
          list: const [],
          tone: Palette.leaf300,
        );
      case IssueTag.waiting:
        if (head.lastRun?.outcome == Outcome.failed) return (head: '这一轮没做成', line: summary, list: const [], tone: Palette.berry);
        if (head.lastRun?.outcome == Outcome.interrupted) return (head: '停在了半路', line: summary, list: const [], tone: Palette.wheat);
        if (issue?.acceptedAt != null) return (head: '验收过了，可以收获', line: summary, list: const [], tone: Palette.leaf300);
        return (head: '等你验收 · $who交回来了${round == null ? '' : '（$round）'}', line: summary, list: const [], tone: Palette.wheat);
      default:
        final closed = issue?.closedAt;
        return (head: closed == null ? tag.label : '${tag.label} · ${wallClockText(closed)}', line: summary, list: const [], tone: Palette.cream200);
    }
  }

  /// The doing glyph goes beside the status while a tool is at work.
  bool get showsDoing => tag == IssueTag.working && current.action != SessionAction.none;
}

/// 没过: what the box says, one finding a line, blank lines dropped.
List<String> findingsOf(String text) => [
  for (final l in text.split('\n'))
    if (l.trim().isNotEmpty) l.trim(),
];

/// The one line over an issue's changes.
String changesLine(Changes c) {
  final added = c.files.fold<double>(0, (n, f) => n + f.added).round();
  final removed = c.files.fold<double>(0, (n, f) => n + f.removed).round();
  return '${c.branch ?? ''} → ${c.base} · ${c.commits.length} 个提交 · +$added -$removed${c.uncommitted.isNotEmpty ? ' · ${c.uncommitted.length} 个没提交' : ''}';
}

/// The empty 干活过程 says why.
String noStepsText(Session head) => head.endedAt == null ? '还没有步骤。' : '干活过程只留 30 天（配置里的 session.trajectory_days），这张工单的已经清掉了。';
