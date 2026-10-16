// What the warehouse, the log and the seed bag read from the farm's state: the issues harvested into the main branch,
// the helpers' reports of their turns (report messages in the chat), and what was asked of helpers lately. Nothing of
// it is kept apart: it is all the issues' and the chat's.

import '../gen/vibevalley.dart';

/// The issues harvested into the main branch (a job's, or a whole playbook's), the latest first: the warehouse.
List<Issue> harvestedOf(FarmState? s) => [
  for (final i in s?.issues ?? const <Issue>[])
    if (i.closed == IssueClose.harvested) i,
]..sort((a, b) => (b.closedAt ?? 0).compareTo(a.closedAt ?? 0));

/// The helpers' reports of their turns, in every conversation, newest first.
List<ChatMessage> turnReportsOf(FarmState? s) => [
  for (final m in s?.chat?.messages ?? const <ChatMessage>[])
    if (m.kind == MessageKind.report && m.final_) m,
]..sort((a, b) => b.at.compareTo(a.at));

/// The issue a helper's run worked.
Issue? issueOfRun(FarmState? s, String helper) => (s?.issues ?? const <Issue>[]).where((i) => i.runs.contains(helper)).firstOrNull;

/// What was asked of helpers lately, newest first: the titles of the issues written or sent, a playbook's aside.
List<String> askedOf(FarmState? s) {
  final all = [
    for (final i in s?.issues ?? const <Issue>[])
      if (i.plan == null && i.parent == null) i,
  ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return [for (final i in all) i.title];
}
