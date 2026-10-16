// The chat itself is the server's (FarmState.chat, folded there); here is only what the client adds.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../shell/prefs.dart';
import '../../village/village_view.dart' show agentsProvider;
import '../../voice/captions.dart';
import 'chat_rules.dart';
import '../../rules/chat.dart';
import '../../rules/session.dart';

const chatPage = 50;

/// Tests override it with a VibeValleyApi over a MockClient.
final chatApiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

class ChatValue<T> extends Notifier<T> {
  ChatValue(this._initial);
  final T _initial;
  @override
  T build() => _initial;
  void set(T value) => state = value;
}

/// null: the square.
final chatShownProvider = NotifierProvider<ChatValue<double?>, double?>(() => ChatValue(null));

final chatOpenProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(true));

final chatLargeProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(false));

final chatLoadedProvider = NotifierProvider<ChatValue<Map<double, Loaded>>, Map<double, Loaded>>(() => ChatValue(const {}));

final spokenProvider = NotifierProvider<SpokenLines, List<Line>>(SpokenLines.new);

final shownConversationProvider = Provider<Conversation?>((ref) {
  final chat = ref.watch(farmProvider)?.chat;
  final id = ref.watch(chatShownProvider);
  return (id == null ? null : conversationOf(chat, id)) ?? squareOf(chat);
});

final chatProjectNamesProvider = FutureProvider<List<String>>((ref) async {
  final all = await ref.watch(chatApiProvider).farm.projects();
  all.sort((a, b) {
    final byLast = (b.last ?? 0).compareTo(a.last ?? 0);
    return byLast != 0 ? byLast : a.name.compareTo(b.name);
  });
  return [for (final p in all) p.name];
});

/// The work log's port sets this; until then nothing shows.
typedef TurnStepsBuilder = Widget? Function(BuildContext context, String id, double at, {required bool manager});
TurnStepsBuilder? chatTurnSteps;

/// Each caption keeps one id and the time it was first seen.
class SpokenLines extends Notifier<List<Line>> {
  final _ids = Expando<int>();
  final _seen = Expando<double>();
  var _next = 1;

  @override
  List<Line> build() => const [];

  void sync(List<Caption> turns) {
    final byId = {for (final l in state) l.id: l};
    var changed = false;
    for (final c in turns) {
      final id = _ids[c] ??= _next++;
      final at = _seen[c] ??= DateTime.now().millisecondsSinceEpoch.toDouble();
      final line = Line(id: id, role: c.speaker == Speaker.you ? LineRole.user : LineRole.foreman, text: c.text, final_: c.done, at: at);
      final was = byId[id];
      if (was == null || was.text != line.text || was.final_ != line.final_) {
        byId[id] = line;
        changed = true;
      }
    }
    if (changed) state = byId.values.toList()..sort((a, b) => a.id.compareTo(b.id));
  }
}

String problemOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

class ChatActions {
  ChatActions(this._ref);
  final Ref _ref;

  VibeValleyApi get _api => _ref.read(chatApiProvider);
  Chat? get _chat => _ref.read(farmProvider)?.chat;

  Future<void> showChat(double? conversation) async {
    _ref.read(chatShownProvider.notifier).set(conversation);
    if (conversation != null && !_ref.read(chatLoadedProvider).containsKey(conversation)) await _fetchPage(conversation);
  }

  Future<bool> showJobThread(String helper) async {
    final thread = jobThreadOf(_chat, helper);
    if (thread == null) return false;
    await showChat(thread.id);
    return true;
  }

  Future<void> _fetchPage(double conversation, [double? before]) async {
    final page = await _api.farm.chatHistory(id: idText(conversation), before: before == null ? null : idText(before), limit: '$chatPage');
    final loaded = _ref.read(chatLoadedProvider.notifier);
    final all = _ref.read(chatLoadedProvider);
    final was = all[conversation] ?? const Loaded([], complete: false);
    loaded.set({...all, conversation: was.merge(page, complete: page.length < chatPage)});
  }

  Future<void> loadOlder(double conversation) async {
    final more = _ref.read(chatLoadedProvider)[conversation];
    if (more?.complete ?? false) return;
    final oldest = messagesOf(_chat, conversation, more).firstOrNull;
    await _fetchPage(conversation, oldest?.seq);
  }

  Future<void> markRead(double conversation) async {
    final chat = _chat;
    final c = conversationOf(chat, conversation);
    final seq = c == null ? null : newestUnread(chat, c);
    if (seq == null) return;
    await _api.farm.chatRead(
      id: idText(conversation),
      body: ChatReadRequest(seq: seq),
    );
  }

  /// You can type before you have said hello.
  Future<bool> whenLive() async {
    final now = _ref.read(farmProvider)?.call;
    if (now == CallState.live) return true;
    if (now != CallState.connecting) unawaited(_api.farm.start().catchError((Object _) {}));
    final deadline = DateTime.now().add(connectWait);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final call = _ref.read(farmProvider)?.call;
      if (call == CallState.live) return true;
      if (call == CallState.error) return false;
    }
    return false;
  }

  String? pickedAgent() {
    final pick = _ref.read(prefsProvider).pick;
    if (pick == 'auto') return null;
    final agents = _ref.read(agentsProvider).value;
    return agents != null && agents.containsKey(pick) ? pick : null;
  }

  Future<void> sayIn(double conversation, String text) async {
    final said = text.trim();
    if (said.isEmpty || !await whenLive()) return;
    await _api.farm.say(
      body: SayRequest(text: said, conversation: conversation, agent: pickedAgent()),
    );
  }

  Future<void> talk(String text) async {
    final said = text.trim();
    if (said.isEmpty || !await whenLive()) return;
    await _api.farm.say(
      body: SayRequest(text: said, agent: pickedAgent()),
    );
  }

  Future<void> openChannel(ChannelRequest req) async {
    final name = req.name.trim().replaceFirst(RegExp('^#'), '');
    await _api.farm.openChannel(
      body: ChannelRequest(name: name, description: req.description, project: req.project),
    );
    for (var i = 0; i < 40; i++) {
      final found = channelsOf(_chat).where((c) => c.name == name).firstOrNull;
      if (found != null) return showChat(found.kind == ConversationKind.square ? null : found.id);
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }

  Future<void> updateChannel(double id, ChannelUpdate update) => _api.farm.updateChannel(id: idText(id), body: update);

  Future<void> setScheduleEnabled(double id, bool enabled) => _api.farm.toggleSchedule(
    id: idText(id),
    body: ToggleScheduleRequest(enabled: enabled),
  );

  Future<void> removeSchedule(double id) => _api.farm.removeSchedule(id: idText(id));

  Future<FarmSchedule> addSchedule(ScheduleRequest req) => _api.farm.addSchedule(body: req);
}

final chatActionsProvider = Provider<ChatActions>(ChatActions.new);
