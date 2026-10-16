// Nothing here folds facts.

import '../../gen/vibevalley.dart';
import '../../rules/chat.dart';
import '../../rules/farm.dart';

int unreadUnder(Chat? chat, Conversation channel) => [
  ...?chat?.conversations.where(
    (c) => c.id == channel.id || c.channel == channel.id || (channel.kind == ConversationKind.square && c.kind == ConversationKind.thread && c.channel == null),
  ),
].fold(0, (n, c) => n + unreadIn(chat, c));

String channelLabel(Conversation? c) => c?.kind == ConversationKind.channel ? '#${c!.name ?? ''}' : squareName;

String channelName(Conversation? c) => c?.kind == ConversationKind.channel ? (c!.name ?? '') : squareName;

int phaseDot(Phase p) => switch (p) {
  PhaseWorking() || PhaseArriving() => 0xFF74A046,
  PhaseFailed() => 0xFFC84A3A,
  _ => 0xFFE5A93C,
};

const menuMax = 6;

class Nameable {
  const Nameable({required this.token, required this.name, required this.note, this.helper});
  final String token;
  final String name;
  final String note;
  final Helper? helper;
}

/// Everyone only when there is more than one helper.
List<Nameable> nameables(List<Helper> helpers, double now) => [
  for (final h in helpers) Nameable(token: '@${h.id}', name: h.name, note: phaseText(h, now), helper: h),
  Nameable(token: mentionOf['foreman']!, name: '管家', note: '派活、拆计划、问进度'),
  if (helpers.length > 1) Nameable(token: mentionOf[everyone]!, name: '所有人', note: '叫醒地里每个帮工'),
];

final _typed = RegExp(r'(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]*)$', unicode: true);

({int start, String query})? typedName(String text, int caret) {
  if (caret < 0 || caret > text.length) return null;
  final m = _typed.firstMatch(text.substring(0, caret));
  if (m == null) return null;
  final q = m.group(2) ?? '';
  return (start: caret - q.length - 1, query: q);
}

/// By the start of the token or anywhere in the name.
List<Nameable> offeredFor(List<Nameable> all, String query) {
  final q = query.toLowerCase();
  return all.where((n) => n.token.substring(1).toLowerCase().startsWith(q) || n.name.toLowerCase().contains(q)).take(menuMax).toList();
}

/// 7, not 7.0.
String _n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

String idText(double id) => _n(id);
