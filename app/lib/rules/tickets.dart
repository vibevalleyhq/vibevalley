// A 工单 is the server's Issue (server/internal/tickets/issues.go): one id from written down to closed, its runs (the
// helpers that worked it, oldest first) under it, its status from the server. A run's details (who, rounds, cost,
// last summary) are on its trajectory head and, while it is on the farm, its helper.

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

/// The state of an issue that has been sent: the server's status while open, how it closed after.
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

/// An issue's title; a playbook's step (a sub-issue) as its playbook's title and its own, while the playbook is among
/// `plans`; a step from before playbooks were issues, from the brief its helper was given.
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

/// Whether an issue is the one asked for by `id`: its own id, or the id of one of its runs (a helper's).
bool ticketIs(Issue issue, String id) => issue.id == id || issue.runs.contains(id);

/// Where a playbook stands on the board: being split or worked (处理中), or waiting for you to look it over, go on with
/// it or harvest it (等你看); done or given up, its steps are on the board as closed tickets and it is not.
Lane? playbookLane(Playbook p) => switch (p.state) {
  PlaybookState.planning || PlaybookState.running => Lane.working,
  PlaybookState.draft || PlaybookState.paused || PlaybookState.ripe => Lane.waiting,
  PlaybookState.done || PlaybookState.abandoned => null,
};

/// What a playbook's card says it waits for, or how far it is.
String playbookLine(Playbook p) => switch (p.state) {
  PlaybookState.planning => '在拆步骤',
  PlaybookState.draft => '拆好了，看过再开工',
  PlaybookState.running => '做到 ${p.nodes.where((n) => n.state == NodeState.merged || n.state == NodeState.skipped).length} / ${p.nodes.length} 步',
  PlaybookState.paused => '暂停了',
  PlaybookState.ripe => '都做完了，等你收获',
  PlaybookState.done => '收获了',
  PlaybookState.abandoned => '放弃了',
};

/// The helper on the farm working an issue's last run, while it is open.
Helper? ticketHelper(FarmState? farm, Issue issue) =>
    farm == null || issue.runs.isEmpty || issue.closed != null ? null : farm.helpers.where((h) => h.id == issue.runs.last).firstOrNull;

/// The board's columns, left to right: written down, being worked, waiting for you, closed.
enum Lane {
  todo('待办'),
  working('处理中'),
  waiting('等你看'),
  closed('已关');

  const Lane(this.label);
  final String label;
}

/// The lane of an issue that has been sent.
Lane laneOf(TicketState s) => switch (s) {
  TicketState.working => Lane.working,
  TicketState.waiting => Lane.waiting,
  _ => Lane.closed,
};

/// What dragging a card between lanes does: a 待办 started, a ticket closed (harvested or sent home), a closed one
/// reopened.
enum Move { start, close, reopen }

/// The move from one lane to another; null when a card cannot go there. A step of a playbook (`planned`) goes with its
/// playbook: merged into the playbook's branch by itself, harvested with it, never closed or reopened alone.
Move? moveOf(Lane from, Lane to, {bool planned = false}) => switch ((from, to)) {
  (Lane.todo, Lane.working) => Move.start,
  (Lane.working, Lane.closed) || (Lane.waiting, Lane.closed) when !planned => Move.close,
  (Lane.closed, Lane.working) when !planned => Move.reopen,
  _ => null,
};

/// Whether an issue is a playbook's, or a step of one: a parent issue with a plan, a sub-issue, its helper working for
/// a playbook, or closed by merging into a playbook's branch.
bool ticketPlanned(Issue issue, Helper? helper) => issue.plan != null || issue.parent != null || helper?.playbook != null || issue.closed == IssueClose.merged;

/// Whether a card matches what was typed into the board's search: every word somewhere in its fields, case aside.
bool matchesQuery(String query, Iterable<String?> fields) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
  if (words.isEmpty) return true;
  final text = fields.whereType<String>().join('\n').toLowerCase();
  return words.every(text.contains);
}

/// How many closed tickets the board shows before 「更早的」.
const closedShown = 15;

/// The working beds: how many tickets can be worked at once.
const workingBeds = 6;
