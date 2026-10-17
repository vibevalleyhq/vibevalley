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
    IssueClose.mergedIntoPlan => IssueTag.merged,
    IssueClose.dismissed => IssueTag.dropped,
    IssueClose.lost => IssueTag.lost,
    IssueClose.answered => IssueTag.answered,
    null => IssueTag.closed,
  };
}

bool isForManager(Issue issue) => issue.assignee == managerAgent;

String issueTitle(Issue issue, [List<Playbook> plans = const []]) {
  final job = issue.title.trim();
  if (job.isEmpty) return issue.id;
  if (issue.parent case final parent?) {
    final playbook = plans.where((p) => p.id == parent).firstOrNull;
    if (playbook != null) return '${playbook.title} · $job';
  }
  return job.split('\n').first.trim();
}

bool issueIs(Issue issue, String id) => issue.id == id || issue.sessions.contains(id);

Lane? playbookLane(Playbook p) => switch (p.state) {
  PlaybookState.planning || PlaybookState.running => Lane.working,
  PlaybookState.draft || PlaybookState.paused || PlaybookState.ripe => Lane.waiting,
  PlaybookState.done || PlaybookState.abandoned => null,
};

String playbookLine(Playbook p) => switch (p.state) {
  PlaybookState.planning => '在拆步骤',
  PlaybookState.draft => '拆好了，看过再开工',
  PlaybookState.running => '做到 ${p.settled ?? 0} / ${p.nodes.length} 步',
  PlaybookState.paused => '暂停了',
  PlaybookState.ripe => '都做完了，等你收获',
  PlaybookState.done => '收获了',
  PlaybookState.abandoned => '放弃了',
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

/// A playbook's step (`planned`) goes with its playbook: never closed or reopened alone.
Move? moveOf(Lane from, Lane to, {bool planned = false}) => switch ((from, to)) {
  (Lane.todo, Lane.working) => Move.start,
  (Lane.working, Lane.closed) || (Lane.waiting, Lane.closed) when !planned => Move.close,
  (Lane.closed, Lane.working) when !planned => Move.reopen,
  _ => null,
};

bool issuePlanned(Issue issue, Session? session) =>
    issue.plan != null || issue.parent != null || session?.playbook != null || issue.closed == IssueClose.mergedIntoPlan;

bool matchesQuery(String query, Iterable<String?> fields) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
  if (words.isEmpty) return true;
  final text = fields.whereType<String>().join('\n').toLowerCase();
  return words.every(text.contains);
}

const closedShown = 15;

String runTriggerText(RunTrigger t) => switch (t.kind) {
  RunTriggerKind.issue => '派出去',
  RunTriggerKind.comment => t.message != null ? '带话（#${t.message!.round()}）' : '带话',
  RunTriggerKind.playbook => '种植计划',
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
