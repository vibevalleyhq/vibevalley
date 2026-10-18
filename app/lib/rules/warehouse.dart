import '../gen/vibevalley.dart';

List<Issue> harvestedOf(CoreState? s) => [
  for (final i in s?.issues ?? const <Issue>[])
    if (i.closed == IssueClose.merged) i,
]..sort((a, b) => (b.closedAt ?? 0).compareTo(a.closedAt ?? 0));

List<ChatMessage> turnReportsOf(CoreState? s) => [
  for (final m in s?.chat?.messages ?? const <ChatMessage>[])
    if (m.kind == MessageKind.report && m.final_) m,
]..sort((a, b) => b.at.compareTo(a.at));

Issue? issueOfSession(CoreState? s, String session) => (s?.issues ?? const <Issue>[]).where((i) => i.sessions.contains(session)).firstOrNull;
