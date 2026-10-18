import '../gen/vibevalley.dart';

enum IssueTag {
  working('处理中'),
  waiting('等你看'),
  harvested('已收获'),
  merged('合进了计划'),
  dropped('没收就收工了'),
  lost('丢了'),
  answered('管家答完了'),
  closed('已关');

  const IssueTag(this.label);
  final String label;

  bool get open => this == working || this == waiting;
}

IssueTag issueTag(Issue issue) {
  switch (issue.status) {
    case IssueStatus.inProgress:
      return IssueTag.working;
    case IssueStatus.inReview:
      return IssueTag.waiting;
    case IssueStatus.backlog || IssueStatus.todo || IssueStatus.done || IssueStatus.canceled:
      break;
  }
  return switch (issue.closed) {
    IssueClose.merged => IssueTag.harvested,
    IssueClose.mergedIntoGraph => IssueTag.merged,
    IssueClose.dismissed => IssueTag.dropped,
    IssueClose.lost => IssueTag.lost,
    IssueClose.answered => IssueTag.answered,
    null => IssueTag.closed,
  };
}

bool isForManager(Issue issue) => issue.assignee == managerAgent;

String issueTitle(Issue issue, [List<TaskGraph> graphs = const []]) {
  final job = issue.title.trim();
  if (job.isEmpty) return issue.id;
  if (issue.parent case final parent?) {
    final graph = graphs.where((p) => p.id == parent).firstOrNull;
    if (graph != null) return '${graph.title} · $job';
  }
  return job.split('\n').first.trim();
}

bool issueIs(Issue issue, String id) => issue.id == id || issue.sessions.contains(id);

Lane? taskLane(TaskGraph p) => switch (p.state) {
  GraphState.splitting || GraphState.running => Lane.working,
  GraphState.draft || GraphState.paused || GraphState.ripe => Lane.waiting,
  GraphState.done || GraphState.abandoned => null,
};

String taskLine(TaskGraph p) => switch (p.state) {
  GraphState.splitting => '在拆步骤',
  GraphState.draft => '拆好了，看过再开工',
  GraphState.running => '做到 ${p.settled ?? 0} / ${p.tasks.length} 步',
  GraphState.paused => '暂停了',
  GraphState.ripe => '都做完了，等你收获',
  GraphState.done => '收获了',
  GraphState.abandoned => '放弃了',
};

Session? issueSession(CoreState? farm, Issue issue) =>
    farm == null || issue.sessions.isEmpty || issue.closed != null ? null : farm.sessions.where((h) => h.id == issue.sessions.last).firstOrNull;

enum Lane {
  todo('待办'),
  working('处理中'),
  waiting('等你看'),
  closed('已关');

  const Lane(this.label);
  final String label;
}

Lane laneOf(IssueStatus s) => switch (s) {
  IssueStatus.backlog || IssueStatus.todo => Lane.todo,
  IssueStatus.inProgress => Lane.working,
  IssueStatus.inReview => Lane.waiting,
  IssueStatus.done || IssueStatus.canceled => Lane.closed,
};

enum Move { start, close, reopen }

/// A drop between lanes, if the server lets the issue go there (`Issue.moves`): todo starts or reopens it, done or
/// canceled closes it. A task's issue has no moves: it goes with its task.
Move? moveOf(Lane from, Lane to, List<IssueStatus> moves) => switch ((from, to)) {
  (Lane.todo, Lane.working) when moves.contains(IssueStatus.todo) => Move.start,
  (Lane.working || Lane.waiting, Lane.closed) when moves.contains(IssueStatus.done) || moves.contains(IssueStatus.canceled) => Move.close,
  (Lane.closed, Lane.working) when moves.contains(IssueStatus.todo) => Move.reopen,
  _ => null,
};

bool issueInTask(Issue issue, Session? session) =>
    issue.graph != null || issue.parent != null || session?.graph != null || issue.closed == IssueClose.mergedIntoGraph;

bool matchesQuery(String query, Iterable<String?> fields) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
  if (words.isEmpty) return true;
  final text = fields.whereType<String>().join('\n').toLowerCase();
  return words.every(text.contains);
}

const closedShown = 15;

String runTriggerText(RunTrigger t) => switch (t.kind) {
  RunTriggerKind.issue => '派出去',
  RunTriggerKind.comment => t.message != null ? '带话（#${t.message!.length > 8 ? t.message!.substring(0, 8) : t.message!}）' : '带话',
  RunTriggerKind.task => '种植计划',
  RunTriggerKind.schedule => t.missed == true ? '定时（补跑）' : '定时',
  RunTriggerKind.runtime => '农机自己',
};

/// One line for a run: what started it, how it went, how long, what it cost, what it heard while it ran. `took` is tookText.
String runText(Run r, double now, String Function(double ms) took) => [
  runTriggerText(r.triggeredBy),
  switch (r.outcome) {
    null => '正在干',
    Outcome.completed => '做完了',
    Outcome.failed => '没做成',
    Outcome.interrupted => '叫停了',
  },
  took((r.endedAt ?? now) - r.startedAt),
  if (r.spent?.cny case final cny?) '¥${cny.toStringAsFixed(2)}',
  if (r.heard.isNotEmpty) '中途听到 ${r.heard.length} 句',
].join(' · ');
