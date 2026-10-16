// The chat's rules that belong to the web page rather than the protocol, for the farm window and the desk; the
// protocol's and core's chat rules are rules/chat.dart's:
//   web/src/farm/Channels.tsx           unreadUnder, channelLabel, phaseDot
//   web/src/farm/Chat.tsx               Nameable, nameables, typedName, offeredFor, MENU_MAX
//   idText                              a conversation or schedule id in a URL path
// Nothing here folds facts: it only reads the chat the server sent.

import '../../gen/vibevalley.dart';
import '../../rules/chat.dart';
import '../../rules/farm.dart';

/// Unread in a channel and the threads under it (Channels.tsx unreadUnder).
int unreadUnder(Chat? chat, Conversation channel) => [
  ...?chat?.conversations.where(
    (c) => c.id == channel.id || c.channel == channel.id || (channel.kind == ConversationKind.square && c.kind == ConversationKind.thread && c.channel == null),
  ),
].fold(0, (n, c) => n + unreadIn(chat, c));

/// The farm window's name for a channel: #name, or 田头.
String channelLabel(Conversation? c) => c?.kind == ConversationKind.channel ? '#${c!.name ?? ''}' : squareName;

/// The desk's name for a channel: its name, or 田头.
String channelName(Conversation? c) => c?.kind == ConversationKind.channel ? (c!.name ?? '') : squareName;

/// The dot on a helper's face: green while it works, red when it failed, wheat otherwise.
int phaseDot(Phase p) => switch (p) {
  PhaseWorking() || PhaseArriving() => 0xFF74A046,
  PhaseFailed() => 0xFFC84A3A,
  _ => 0xFFE5A93C,
};

// ── Naming someone with @ ────────────────────────────────────────────────────

/// Names offered at most.
const menuMax = 6;

/// Someone the person can name: a helper by its id, the manager, everyone.
class Nameable {
  const Nameable({required this.token, required this.name, required this.note, this.helper});
  final String token;
  final String name;
  final String note;
  final Helper? helper;
}

/// The helpers on the farm, the manager, and everyone when there is more than one helper (Chat.tsx useNameables).
List<Nameable> nameables(List<Helper> helpers, double now) => [
  for (final h in helpers) Nameable(token: '@${h.id}', name: h.name, note: phaseText(h, now), helper: h),
  Nameable(token: mentionOf['foreman']!, name: '管家', note: '派活、拆计划、问进度'),
  if (helpers.length > 1) Nameable(token: mentionOf[everyone]!, name: '所有人', note: '叫醒地里每个帮工'),
];

final _typed = RegExp(r'(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]*)$', unicode: true);

/// The @word being typed just before the caret: where it starts and what is typed of it.
({int start, String query})? typedName(String text, int caret) {
  if (caret < 0 || caret > text.length) return null;
  final m = _typed.firstMatch(text.substring(0, caret));
  if (m == null) return null;
  final q = m.group(2) ?? '';
  return (start: caret - q.length - 1, query: q);
}

/// The names that match what is typed after @: by the start of the token or anywhere in the name.
List<Nameable> offeredFor(List<Nameable> all, String query) {
  final q = query.toLowerCase();
  return all.where((n) => n.token.substring(1).toLowerCase().startsWith(q) || n.name.toLowerCase().contains(q)).take(menuMax).toList();
}

/// A number as the page writes it: 7, not 7.0.
String _n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

/// A conversation or schedule id for a URL path.
String idText(double id) => _n(id);
