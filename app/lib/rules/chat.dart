// Nothing here folds facts: it only reads the chat the server sent.

import '../gen/vibevalley.dart';

const mentionOf = {managerAgent: '@管家', 'user': '@主人', everyone: '@所有人'};

/// Each once, in order; code names no one.
bool isChannel(Conversation c) => c.kind != ConversationKind.thread;

Conversation? generalOf(Chat? chat) => chat?.conversations.where((c) => c.kind == ConversationKind.general).firstOrNull;

List<Conversation> channelsOf(Chat? chat) {
  final all = [...?chat?.conversations.where(isChannel)];
  all.sort((a, b) {
    if (a.kind == ConversationKind.general) return -1;
    if (b.kind == ConversationKind.general) return 1;
    return a.id.compareTo(b.id);
  });
  return all;
}

Conversation? conversationOf(Chat? chat, String id) => chat?.conversations.where((c) => c.id == id).firstOrNull;

Conversation? channelOf(Chat? chat, Conversation? c) {
  if (c == null) return generalOf(chat);
  if (isChannel(c)) return c;
  return conversationOf(chat, c.channel ?? "") ?? generalOf(chat);
}

/// One thread per issue, kept across the sessions that work it.
Conversation? issueThreadOf(Chat? chat, String issue) => chat?.conversations.lastWhereOrNull((c) => c.subjectKind == SubjectKind.issue && c.subjectId == issue);

/// The one way from a session to its thread: through its issue; a session sent for no issue has a talk thread of its own.
Conversation? jobThreadOf(Chat? chat, Session session) {
  final issue = session.issue;
  if (issue != null && issue.isNotEmpty) return issueThreadOf(chat, issue);
  return chat?.conversations.lastWhereOrNull((c) => c.subjectKind == SubjectKind.talk && c.subjectId == session.id);
}

/// Whom a thread's words are for now: the session working its issue, or a talk thread's own session.
Session? threadOwnerOf(Conversation thread, List<Session> sessions) => switch (thread.subjectKind) {
  SubjectKind.issue => sessions.lastWhereOrNull((h) => h.issue == thread.subjectId),
  SubjectKind.talk => sessions.where((h) => h.id == thread.subjectId).firstOrNull,
  SubjectKind.graph || null => null,
};

/// An issue's thread is named by the issue, so the name holds after its sessions leave.
String threadTitle(Chat? chat, Conversation thread, {List<Issue> issues = const [], List<Session> sessions = const []}) {
  String head(String text) {
    final flat = text.replaceAll(RegExp(r'\s+'), ' ');
    return flat.length > 24 ? flat.substring(0, 24) : flat;
  }

  switch (thread.subjectKind) {
    case SubjectKind.issue:
      final issue = issues.where((i) => i.id == thread.subjectId).firstOrNull;
      return issue == null ? '工单串' : head(issue.title);
    case SubjectKind.graph:
      return '计划 ${thread.subjectId ?? ''}';
    case SubjectKind.talk when thread.subjectId != null:
      final session = sessions.where((h) => h.id == thread.subjectId).firstOrNull;
      final said = messagesIn(chat, thread.id).where((m) => m.from == thread.subjectId).firstOrNull?.name;
      return '${session?.name ?? said ?? thread.subjectId}的串';
    case SubjectKind.talk || null:
      final parent = parentOf(chat, thread);
      return parent == null ? '串' : head(parent.text);
  }
}

List<ChatMessage> messagesIn(Chat? chat, String conversation) => [...?chat?.messages.where((m) => m.conversation == conversation)];

int unreadIn(Chat? chat, Conversation c) =>
    messagesIn(chat, c.id).where((m) => m.number > (c.read ?? 0) && m.from != 'user' && m.kind != MessageKind.notice && m.final_).length;

int unreadTotal(Chat? chat) => [...?chat?.conversations].fold(0, (n, c) => n + unreadIn(chat, c));

double? newestUnread(Chat? chat, Conversation c) => messagesIn(chat, c.id).lastWhereOrNull((m) => m.final_ && m.number > (c.read ?? 0))?.number;

enum LineRole { user, manager }

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
    final all = {for (final m in messages) m.id: m};
    for (final m in more) {
      all[m.id] = m;
    }
    final sorted = all.values.toList()..sort((a, b) => a.number.compareTo(b.number));
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
  String get key => message.id;
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

List<ChatMessage> messagesOf(Chat? chat, String conversation, [Loaded? more]) {
  final all = <String, ChatMessage>{};
  for (final m in more?.messages ?? const <ChatMessage>[]) {
    all[m.id] = m;
  }
  for (final m in messagesIn(chat, conversation)) {
    all[m.id] = m;
  }
  return all.values.toList()..sort((a, b) => a.number.compareTo(b.number));
}

ChatMessage? parentOf(Chat? chat, Conversation thread, [Loaded? more]) {
  final p = thread.parent;
  if (p == null) return null;
  return chat?.messages.where((m) => m.id == p).firstOrNull ?? more?.messages.where((m) => m.id == p).firstOrNull;
}

/// On the general (or before the server sent it) the spoken lines are woven in by time.
List<ChatItem> itemsOf(Chat? chat, Conversation? conversation, List<Line> lines, [Loaded? more]) {
  final threads = {
    for (final c in chat?.conversations ?? const <Conversation>[])
      if (c.kind == ConversationKind.thread && c.parent != null) c.parent!: c,
  };
  final messages = conversation == null ? <ChatItem>[] : <ChatItem>[for (final m in messagesOf(chat, conversation.id, more)) MessageItem(m, threads[m.id])];
  if (conversation != null && conversation.kind != ConversationKind.general) return messages;
  final all = [...messages, for (final l in lines) SpokenItem(l)];
  // A stable sort: messages and lines at the same moment keep their order.
  final indexed = all.indexed.toList()..sort((a, b) => a.$2.at.compareTo(b.$2.at) != 0 ? a.$2.at.compareTo(b.$2.at) : a.$1.compareTo(b.$1));
  return [for (final (_, item) in indexed) item];
}

/// 7, not 7.0.
extension _LastWhere<T> on Iterable<T> {
  T? lastWhereOrNull(bool Function(T) test) {
    T? found;
    for (final e in this) {
      if (test(e)) found = e;
    }
    return found;
  }
}
