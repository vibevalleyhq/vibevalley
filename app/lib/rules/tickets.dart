import '../gen/vibevalley.dart';

enum TicketState {
  working('处理中'),
  waiting('等你看'),
  harvested('已收获'),
  merged('合进了计划'),
  dropped('没收就收工了'),
  lost('丢了'),
  closed('已关');

  const TicketState(this.label);
  final String label;

  bool get open => this == working || this == waiting;
}

TicketState ticketState(Issue issue) {
  switch (issue.status) {
    case IssueStatus.working:
      return TicketState.working;
    case IssueStatus.waiting:
      return TicketState.waiting;
    case IssueStatus.todo || IssueStatus.queued || IssueStatus.closed:
      break;
  }
  return switch (issue.closed) {
    IssueClose.harvested => TicketState.harvested,
    IssueClose.merged => TicketState.merged,
    IssueClose.dismissed => TicketState.dropped,
    IssueClose.lost => TicketState.lost,
    null => TicketState.closed,
  };
}

String ticketTitle(Issue issue, [List<Playbook> plans = const []]) {
  final job = issue.title.trim();
  if (job.isEmpty) return issue.id;
  if (issue.parent case final parent?) {
    final playbook = plans.where((p) => p.id == parent).firstOrNull;
    if (playbook != null) return '${playbook.title} · $job';
  }
  final first = job.split('\n').first.trim();
  final brief = RegExp(r'^这是种植计划「(.+?)」里的一步：(.+)$').firstMatch(first);
  return brief == null ? first : '${brief.group(1)} · ${brief.group(2)}';
}

bool ticketIs(Issue issue, String id) => issue.id == id || issue.runs.contains(id);

Lane? playbookLane(Playbook p) => switch (p.state) {
  PlaybookState.planning || PlaybookState.running => Lane.working,
  PlaybookState.draft || PlaybookState.paused || PlaybookState.ripe => Lane.waiting,
  PlaybookState.done || PlaybookState.abandoned => null,
};

String playbookLine(Playbook p) => switch (p.state) {
  PlaybookState.planning => '在拆步骤',
  PlaybookState.draft => '拆好了，看过再开工',
  PlaybookState.running => '做到 ${p.nodes.where((n) => n.state == NodeState.merged || n.state == NodeState.skipped).length} / ${p.nodes.length} 步',
  PlaybookState.paused => '暂停了',
  PlaybookState.ripe => '都做完了，等你收获',
  PlaybookState.done => '收获了',
  PlaybookState.abandoned => '放弃了',
};

Helper? ticketHelper(FarmState? farm, Issue issue) =>
    farm == null || issue.runs.isEmpty || issue.closed != null ? null : farm.helpers.where((h) => h.id == issue.runs.last).firstOrNull;

enum Lane {
  todo('待办'),
  working('处理中'),
  waiting('等你看'),
  closed('已关');

  const Lane(this.label);
  final String label;
}

Lane laneOf(TicketState s) => switch (s) {
  TicketState.working => Lane.working,
  TicketState.waiting => Lane.waiting,
  _ => Lane.closed,
};

enum Move { start, close, reopen }

/// A playbook's step (`planned`) goes with its playbook: never closed or reopened alone.
Move? moveOf(Lane from, Lane to, {bool planned = false}) => switch ((from, to)) {
  (Lane.todo, Lane.working) => Move.start,
  (Lane.working, Lane.closed) || (Lane.waiting, Lane.closed) when !planned => Move.close,
  (Lane.closed, Lane.working) when !planned => Move.reopen,
  _ => null,
};

bool ticketPlanned(Issue issue, Helper? helper) => issue.plan != null || issue.parent != null || helper?.playbook != null || issue.closed == IssueClose.merged;

bool matchesQuery(String query, Iterable<String?> fields) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
  if (words.isEmpty) return true;
  final text = fields.whereType<String>().join('\n').toLowerCase();
  return words.every(text.contains);
}

const closedShown = 15;

const workingBeds = 6;
