// The chat itself is the server's (CoreState.chat, folded there); here is only what the client adds.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/widgets.dart';

import '../data/providers.dart';
import '../data/voice.dart';
import '../gen/vibevalley.dart';
import '../voice/captions.dart';
import '../rules/chat.dart';

const chatPage = 50;

/// Tests override it with a VibeValleyApi over a MockClient.
class ChatValue<T> extends Notifier<T> {
  ChatValue(this._initial);
  final T _initial;
  @override
  T build() => _initial;
  void set(T value) => state = value;
}

/// null: the general.
final chatShownProvider = NotifierProvider<ChatValue<String?>, String?>(() => ChatValue(null));

final chatOpenProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(true));

final chatLargeProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(false));

final chatLoadedProvider = NotifierProvider<ChatValue<Map<String, Loaded>>, Map<String, Loaded>>(() => ChatValue(const {}));

final spokenProvider = NotifierProvider<SpokenLines, List<Line>>(SpokenLines.new);

final shownConversationProvider = Provider<Conversation?>((ref) {
  final chat = ref.watch(stateProvider)?.chat;
  final id = ref.watch(chatShownProvider);
  return (id == null ? null : conversationOf(chat, id)) ?? generalOf(chat);
});

final chatFeedProvider = Provider.autoDispose.family<({List<ChatItem> items, ChatMessage? parent, bool hasOlder}), String?>((ref, id) {
  final chat = ref.watch(stateProvider)?.chat;
  final conversation = id == null ? null : conversationOf(chat, id);
  final history = id == null ? null : ref.watch(chatLoadedProvider.select((all) => all[id]));
  final items = itemsOf(chat, conversation, ref.watch(spokenProvider), history);
  return (
    items: items,
    parent: conversation?.kind == ConversationKind.thread ? parentOf(chat, conversation!, history) : null,
    hasOlder: conversation != null && items.isNotEmpty && !(history?.complete ?? false),
  );
});

/// Watching declares a visible conversation; receipts belong to the frame that displayed it.
final visibleConversationProvider = Provider.autoDispose.family<void, String>((ref, id) {
  final number = ref.watch(
    stateProvider.select((state) {
      final conversation = conversationOf(state?.chat, id);
      return conversation == null || unreadIn(state?.chat, conversation) == 0 ? null : newestUnread(state?.chat, conversation);
    }),
  );
  if (number == null) return;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (ref.mounted) unawaited(ref.read(chatActionsProvider)._markRead(id, number).catchError((Object _) {}));
  });
});

/// Each caption keeps one id and the time it was first seen.
class SpokenLines extends Notifier<List<Line>> {
  final _ids = Expando<int>();
  final _seen = Expando<double>();
  var _next = 1;

  @override
  List<Line> build() {
    ref.listen(voiceCallProvider, (_, call) => sync(call.captions.turns));
    return _merge(const [], ref.read(voiceCallProvider).captions.turns);
  }

  void sync(List<Caption> turns) => state = _merge(state, turns);

  List<Line> _merge(List<Line> before, List<Caption> turns) {
    final byId = {for (final l in before) l.id: l};
    var changed = false;
    for (final c in turns) {
      final id = _ids[c] ??= _next++;
      final at = _seen[c] ??= DateTime.now().millisecondsSinceEpoch.toDouble();
      final line = Line(id: id, role: c.speaker == Speaker.you ? LineRole.user : LineRole.manager, text: c.text, final_: c.done, at: at);
      final was = byId[id];
      if (was == null || was.text != line.text || was.final_ != line.final_) {
        byId[id] = line;
        changed = true;
      }
    }
    return changed ? (byId.values.toList()..sort((a, b) => a.id.compareTo(b.id))) : before;
  }
}

String problemOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

class ChatActions {
  ChatActions(this._ref);
  final Ref _ref;
  final _history = <String, Future<void>>{};

  VibeValleyApi get _api => _ref.read(apiProvider);
  Chat? get _chat => _ref.read(stateProvider)?.chat;

  Future<void> showChat(String? conversation) async {
    _ref.read(chatShownProvider.notifier).set(conversation);
    if (conversation != null && !_ref.read(chatLoadedProvider).containsKey(conversation)) await _fetchPage(conversation);
  }

  Future<bool> showIssueThread(String issue) async {
    final thread = issueThreadOf(_chat, issue);
    if (thread == null) return false;
    await showChat(thread.id);
    return true;
  }

  Future<void> _fetchPage(String conversation, [double? before]) => _history[conversation] ??= _readPage(conversation, before).whenComplete(() {
    _history.remove(conversation);
  });

  Future<void> _readPage(String conversation, double? before) async {
    final page = await _api.channel.history(id: conversation, before: before, limit: chatPage.toDouble());
    if (!_ref.mounted) return;
    final loaded = _ref.read(chatLoadedProvider.notifier);
    final all = _ref.read(chatLoadedProvider);
    final was = all[conversation] ?? const Loaded([], complete: false);
    loaded.set({...all, conversation: was.merge(page, complete: page.length < chatPage)});
  }

  Future<void> loadOlder(String conversation) async {
    final more = _ref.read(chatLoadedProvider)[conversation];
    if (more?.complete ?? false) return;
    final oldest = messagesOf(_chat, conversation, more).firstOrNull;
    await _fetchPage(conversation, oldest?.number);
  }

  Future<void> _markRead(String conversation, double number) => _api.channel.markRead(
    id: conversation,
    body: ChatReadRequest(number: number),
  );

  Future<void> openChannel(ChannelRequest req) async {
    final id = await _api.channel.create(body: req);
    if (_ref.mounted) await showChat(id);
  }

  Future<void> updateChannel(String id, ChannelUpdate update) => _api.channel.update(id: id, body: update);

  Future<void> setScheduleEnabled(String id, bool enabled) => _api.schedule.update(
    id: id,
    body: ScheduleUpdate(enabled: enabled),
  );

  Future<void> removeSchedule(String id) => _api.schedule.delete(id: id);
}

final chatActionsProvider = Provider<ChatActions>(ChatActions.new);
