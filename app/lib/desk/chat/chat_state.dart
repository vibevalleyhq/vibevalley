// The chat as this client holds it (packages/core/src/chat.ts): the chat itself is the server's (FarmState.chat, folded
// there); here is only what the client adds: which conversation is shown (the farm window and the desk show the same
// one), older messages loaded for a conversation, the lines spoken in a voice call, whether the farm window is open
// or enlarged, and the commands (say in a conversation, read cursors, channels, schedules) through VibeValleyApi.

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

/// Messages asked for at a time when a conversation is opened or scrolled back.
const chatPage = 50;

/// The API the chat talks through; tests override it with a VibeValleyApi over a MockClient.
final chatApiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

/// A value held for the app's life.
class ChatValue<T> extends Notifier<T> {
  ChatValue(this._initial);
  final T _initial;
  @override
  T build() => _initial;
  void set(T value) => state = value;
}

/// The conversation shown, in the farm window and on the desk alike: a conversation's id, or null for the square.
final chatShownProvider = NotifierProvider<ChatValue<double?>, double?>(() => ChatValue(null));

/// The farm's chat window is open (core farm/ui.ts chatOpen).
final chatOpenProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(true));

/// The farm's chat window is enlarged (chatLarge).
final chatLargeProvider = NotifierProvider<ChatValue<bool>, bool>(() => ChatValue(false));

/// Messages loaded from the server for each conversation, beyond those the core state keeps; by conversation id.
final chatLoadedProvider = NotifierProvider<ChatValue<Map<double, Loaded>>, Map<double, Loaded>>(() => ChatValue(const {}));

/// The lines spoken in voice calls, oldest first (core spoken); kept after a call ends, as on the web page.
final spokenProvider = NotifierProvider<SpokenLines, List<Line>>(SpokenLines.new);

/// The conversation the chat shows, as the core state has it; null until the server sent the square.
final shownConversationProvider = Provider<Conversation?>((ref) {
  final chat = ref.watch(farmProvider)?.chat;
  final id = ref.watch(chatShownProvider);
  return (id == null ? null : conversationOf(chat, id)) ?? squareOf(chat);
});

/// The work directory's projects, newest-worked first, for the channel forms' suggestions (web farm/projects.ts).
final chatProjectNamesProvider = FutureProvider<List<String>>((ref) async {
  final all = await ref.watch(chatApiProvider).farm.projects();
  all.sort((a, b) {
    final byLast = (b.last ?? 0).compareTo(a.last ?? 0);
    return byLast != 0 ? byLast : a.name.compareTo(b.name);
  });
  return [for (final p in all) p.name];
});

/// The turn behind a message (web farm/WorkLog.tsx TurnSteps): the work log's port sets this; until then nothing shows.
typedef TurnStepsBuilder = Widget? Function(BuildContext context, String id, double at, {required bool manager});
TurnStepsBuilder? chatTurnSteps;

/// The captions of a call as lines: each caption keeps one id and the time it was first seen.
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

/// Why a command failed, in the server's words.
String problemOf(Object e) => e is VibeValleyApiError ? e.reason : '$e';

/// The chat's commands (core chat.ts and session.ts).
class ChatActions {
  ChatActions(this._ref);
  final Ref _ref;

  VibeValleyApi get _api => _ref.read(chatApiProvider);
  Chat? get _chat => _ref.read(farmProvider)?.chat;

  /// Shows a conversation (null: the square); its messages are loaded as it opens.
  Future<void> showChat(double? conversation) async {
    _ref.read(chatShownProvider.notifier).set(conversation);
    if (conversation != null && !_ref.read(chatLoadedProvider).containsKey(conversation)) await _fetchPage(conversation);
  }

  /// Shows a helper's job thread; false when it has none (yet).
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

  /// Loads the messages before the oldest one shown.
  Future<void> loadOlder(double conversation) async {
    final more = _ref.read(chatLoadedProvider)[conversation];
    if (more?.complete ?? false) return;
    final oldest = messagesOf(_chat, conversation, more).firstOrNull;
    await _fetchPage(conversation, oldest?.seq);
  }

  /// The person has read a conversation up to its newest message.
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

  /// Whether the day is on, starting it first if needed: you can type before you have said hello (core whenLive).
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

  /// The agent picked on the friends bar for the next job, when it still exists (core pickedAgent).
  String? pickedAgent() {
    final pick = _ref.read(prefsProvider).pick;
    if (pick == 'auto') return null;
    final agents = _ref.read(agentsProvider).value;
    return agents != null && agents.containsKey(pick) ? pick : null;
  }

  /// Says something typed in a channel or a thread, starting the day first if needed (core sayIn).
  Future<void> sayIn(double conversation, String text) async {
    final said = text.trim();
    if (said.isEmpty || !await whenLive()) return;
    await _api.farm.say(
      body: SayRequest(text: said, conversation: conversation, agent: pickedAgent()),
    );
  }

  /// Says something typed on the square (core talk while no voice call is on: sayWhenLive).
  Future<void> talk(String text) async {
    final said = text.trim();
    if (said.isEmpty || !await whenLive()) return;
    await _api.farm.say(
      body: SayRequest(text: said, agent: pickedAgent()),
    );
  }

  /// Opens a channel and shows it once the server has it; throws with why not. The name may be written with its #.
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

  /// Changes what a channel is for, or its default project; throws with why not.
  Future<void> updateChannel(double id, ChannelUpdate update) => _api.farm.updateChannel(id: idText(id), body: update);

  /// Switches a schedule on or off; it comes back in the core state.
  Future<void> setScheduleEnabled(double id, bool enabled) => _api.farm.toggleSchedule(
    id: idText(id),
    body: ToggleScheduleRequest(enabled: enabled),
  );

  Future<void> removeSchedule(double id) => _api.farm.removeSchedule(id: idText(id));

  /// Makes a schedule (the manager does this when asked; the pages only list them).
  Future<FarmSchedule> addSchedule(ScheduleRequest req) => _api.farm.addSchedule(body: req);
}

final chatActionsProvider = Provider<ChatActions>(ChatActions.new);
