// Nothing here folds facts: it only reads the chat the server sent.

import '../gen/vibevalley.dart';

const squareName = '田头';
const everyone = 'everyone';

const mentionOf = {'foreman': '@管家', 'user': '@主人', everyone: '@所有人'};
const _named = {'管家': 'foreman', '主人': 'user', '所有人': everyone};

final _fence = RegExp(r'```[\s\S]*?```');
final _tick = RegExp(r'`[^`\n]*`');
final _mention = RegExp(r'(^|[^\p{L}\p{N}_@])@(w\d+|管家|主人|所有人)', unicode: true);

/// Each once, in order; code names no one.
List<String> mentionsIn(String text) {
  final prose = text.replaceAll(_fence, ' ').replaceAll(_tick, ' ');
  final found = <String>[];
  for (final m in _mention.allMatches(prose)) {
    final token = m.group(2) ?? '';
    final id = _named[token] ?? token;
    if (!found.contains(id)) found.add(id);
  }
  return found;
}

bool isChannel(Conversation c) => c.kind != ConversationKind.thread;

Conversation? squareOf(Chat? chat) => chat?.conversations.where((c) => c.kind == ConversationKind.square).firstOrNull;

List<Conversation> channelsOf(Chat? chat) {
  final all = [...?chat?.conversations.where(isChannel)];
  all.sort((a, b) {
    if (a.kind == ConversationKind.square) return -1;
    if (b.kind == ConversationKind.square) return 1;
    return a.id.compareTo(b.id);
  });
  return all;
}

Conversation? conversationOf(Chat? chat, double id) => chat?.conversations.where((c) => c.id == id).firstOrNull;

Conversation? channelOf(Chat? chat, Conversation? c) {
  if (c == null) return squareOf(chat);
  if (isChannel(c)) return c;
  return conversationOf(chat, c.channel ?? -1) ?? squareOf(chat);
}

/// `#name`, or `#channel:seq` for a thread (the seq of the message it hangs under).
String targetOf(Conversation c, [String? channelName]) =>
    c.kind == ConversationKind.thread && c.parent != null ? '#${channelName ?? squareName}:${_n(c.parent!)}' : '#${c.name ?? squareName}';

String addressOf(Chat? chat, Conversation c) => targetOf(c, channelOf(chat, c)?.name);

Conversation? threadUnder(Chat? chat, double seq) => chat?.conversations.where((c) => c.kind == ConversationKind.thread && c.parent == seq).firstOrNull;

Conversation? jobThreadOf(Chat? chat, String helper) => chat?.conversations.lastWhereOrNull((c) => c.subjectKind == SubjectKind.job && c.subjectId == helper);

List<ChatMessage> messagesIn(Chat? chat, double conversation) => [...?chat?.messages.where((m) => m.conversation == conversation)];

int unreadIn(Chat? chat, Conversation c) =>
    messagesIn(chat, c.id).where((m) => m.seq > (c.read ?? 0) && m.from != 'user' && m.kind != MessageKind.notice && m.final_).length;

int unreadTotal(Chat? chat) => [...?chat?.conversations].fold(0, (n, c) => n + unreadIn(chat, c));

double? newestUnread(Chat? chat, Conversation c) => messagesIn(chat, c.id).lastWhereOrNull((m) => m.final_ && m.seq > (c.read ?? 0))?.seq;

enum LineRole { user, foreman }

class Line {
  const Line({required this.id, required this.role, required this.text, required this.final_, required this.at});
  final int id;
  final LineRole role;
  final String text;
  final bool final_;
  final double at;
}

class Loaded {
  const Loaded(this.messages, {required this.complete});
  final List<ChatMessage> messages;

  final bool complete;

  Loaded merge(List<ChatMessage> more, {required bool complete}) {
    final all = {for (final m in messages) m.seq: m};
    for (final m in more) {
      all[m.seq] = m;
    }
    final sorted = all.values.toList()..sort((a, b) => a.seq.compareTo(b.seq));
    return Loaded(sorted, complete: complete || this.complete);
  }
}

sealed class ChatItem {
  const ChatItem();
  String get key;
  double get at;

  String get sender;
}

final class MessageItem extends ChatItem {
  const MessageItem(this.message, [this.thread]);
  final ChatMessage message;
  final Conversation? thread;
  @override
  String get key => 'm${_n(message.seq)}';
  @override
  double get at => message.at;
  @override
  String get sender => message.kind == MessageKind.notice ? '' : message.from;
}

final class SpokenItem extends ChatItem {
  const SpokenItem(this.line);
  final Line line;
  @override
  String get key => 's${line.id}';
  @override
  double get at => line.at;
  @override
  String get sender => line.role.name;
}

List<ChatMessage> messagesOf(Chat? chat, double conversation, [Loaded? more]) {
  final all = <double, ChatMessage>{};
  for (final m in more?.messages ?? const <ChatMessage>[]) {
    all[m.seq] = m;
  }
  for (final m in messagesIn(chat, conversation)) {
    all[m.seq] = m;
  }
  return all.values.toList()..sort((a, b) => a.seq.compareTo(b.seq));
}

ChatMessage? parentOf(Chat? chat, Conversation thread, [Loaded? more]) {
  final p = thread.parent;
  if (p == null) return null;
  return chat?.messages.where((m) => m.seq == p).firstOrNull ?? more?.messages.where((m) => m.seq == p).firstOrNull;
}

/// On the square (or before the server sent it) the spoken lines are woven in by time.
List<ChatItem> itemsOf(Chat? chat, Conversation? conversation, List<Line> lines, [Loaded? more]) {
  final threads = {
    for (final c in chat?.conversations ?? const <Conversation>[])
      if (c.kind == ConversationKind.thread && c.parent != null) c.parent!: c,
  };
  final messages = conversation == null ? <ChatItem>[] : <ChatItem>[for (final m in messagesOf(chat, conversation.id, more)) MessageItem(m, threads[m.seq])];
  if (conversation != null && conversation.kind != ConversationKind.square) return messages;
  final all = [...messages, for (final l in lines) SpokenItem(l)];
  // A stable sort: messages and lines at the same moment keep their order.
  final indexed = all.indexed.toList()..sort((a, b) => a.$2.at.compareTo(b.$2.at) != 0 ? a.$2.at.compareTo(b.$2.at) : a.$1.compareTo(b.$1));
  return [for (final (_, item) in indexed) item];
}

/// 7, not 7.0.
String _n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

extension _LastWhere<T> on Iterable<T> {
  T? lastWhereOrNull(bool Function(T) test) {
    T? found;
    for (final e in this) {
      if (test(e)) found = e;
    }
    return found;
  }
}
