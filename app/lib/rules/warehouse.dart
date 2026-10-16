import '../gen/vibevalley.dart';

List<Issue> harvestedOf(FarmState? s) => [
  for (final i in s?.issues ?? const <Issue>[])
    if (i.closed == IssueClose.harvested) i,
]..sort((a, b) => (b.closedAt ?? 0).compareTo(a.closedAt ?? 0));

List<ChatMessage> turnReportsOf(FarmState? s) => [
  for (final m in s?.chat?.messages ?? const <ChatMessage>[])
    if (m.kind == MessageKind.report && m.final_) m,
]..sort((a, b) => b.at.compareTo(a.at));

Issue? issueOfRun(FarmState? s, String helper) => (s?.issues ?? const <Issue>[]).where((i) => i.runs.contains(helper)).firstOrNull;

List<String> askedOf(FarmState? s) {
  final all = [
    for (final i in s?.issues ?? const <Issue>[])
      if (i.plan == null && i.parent == null) i,
  ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return [for (final i in all) i.title];
}
