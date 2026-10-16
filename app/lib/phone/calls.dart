// The farm phone's calls (web/src/phone/Phone.tsx, packages/core/src/phone.ts): what the farm wants of you rings the
// phone as a call. The calls are the server's inbox (SiteFrame.inbox in each frame); which of them were answered or hung up
// on, the call log, and which call rings now are the page's, kept for this session only, as on the web page.
//
// A call rings once, when it is new: what stands when the farm screen opens is already missed, not ringing. It rings
// only while the farm screen is watching (phoneProvider has listeners: the HUD's phone button and the phone itself)
// and no voice call is on; it rings for 20 s, the bell again every 4 s, then counts as missed.

import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../shell/sfx.dart';
import 'phone.dart' show phoneOpenProvider;

/// Why a call came, on the ringing screen and in the lists (protocol view.ts CALL_WHY_LABEL).
String inboxKindLabel(InboxKind kind) => switch (kind) {
  InboxKind.harvest => '活熟了',
  InboxKind.fix => '活没做成',
  InboxKind.conflict => '合不进去',
  InboxKind.quiet => '好久没动静',
  InboxKind.planDraft => '计划拆好了',
  InboxKind.planRipe => '计划能收了',
  InboxKind.planFailed => '计划卡住了',
  InboxKind.mention => '找你',
};

/// The calls not answered or turned down yet, newest first: what rings, and what the phone's badge counts (core
/// phone.ts unansweredCalls).
List<InboxItem> unansweredCalls(List<InboxItem> calls, Set<String> handled) => [
  for (final c in calls)
    if (!handled.contains(c.id)) c,
];

/// One line of the call log.
sealed class PhoneLogEntry {
  const PhoneLogEntry();
}

final class PhoneLogCall extends PhoneLogEntry {
  const PhoneLogCall(this.call, {required this.answered, required this.at});
  final InboxItem call;
  final bool answered;
  final DateTime at;
}

final class PhoneLogVoice extends PhoneLogEntry {
  const PhoneLogVoice({required this.from, required this.to});
  final DateTime from;
  final DateTime to;
}

class PhoneState {
  const PhoneState({this.calls = const [], this.handled = const {}, this.ringing, this.log = const []});

  /// The calls standing now, as the server computed them.
  final List<InboxItem> calls;

  /// Calls answered or hung up on, by id: they stop ringing and leave the missed list.
  final Set<String> handled;

  /// The call ringing now.
  final InboxItem? ringing;

  /// What happened on the phone this session, newest first.
  final List<PhoneLogEntry> log;

  List<InboxItem> get missed => unansweredCalls(calls, handled);

  PhoneState copyWith({List<InboxItem>? calls, Set<String>? handled, InboxItem? Function()? ringing, List<PhoneLogEntry>? log}) =>
      PhoneState(calls: calls ?? this.calls, handled: handled ?? this.handled, ringing: ringing == null ? this.ringing : ringing(), log: log ?? this.log);
}

/// How long a call rings before it counts as missed, and how often the bell sounds while it rings.
const ringFor = Duration(seconds: 20);
const ringEvery = Duration(seconds: 4);
const _logKeep = 40;

final phoneProvider = NotifierProvider<PhoneCalls, PhoneState>(PhoneCalls.new);

class PhoneCalls extends Notifier<PhoneState> {
  /// The missed calls seen so far; null until the farm screen's first look, which rings nothing.
  Set<String>? _known;
  bool _active = true;
  bool _voiceLive = false;
  DateTime? _voiceSince;

  /// The ring put the phone up by itself: it goes away again when the ring ends.
  bool _openedByRing = false;

  /// A voice call started elsewhere (the chat window) put the phone up: it goes away when the call ends.
  bool _openedByVoice = false;
  Timer? _again;
  Timer? _giveUp;

  @override
  PhoneState build() {
    // The view can change while a widget builds (it is read when it is watched there): then the phone's own state
    // follows once that frame is over, as a provider may not change mid-build; otherwise at once.
    ref.listen(inboxProvider, (_, inbox) {
      void follow() {
        if (ref.mounted) _calls(inbox);
      }

      if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
        scheduleMicrotask(follow);
      } else {
        follow();
      }
    });
    ref.onCancel(() => _active = false);
    ref.onResume(() {
      _active = true;
      // Back on the farm screen: what stands now is already missed.
      _known = {for (final c in state.missed) c.id};
    });
    ref.onDispose(_stopBell);
    final calls = ref.read(inboxProvider);
    final first = PhoneState(calls: calls);
    _known = {for (final c in first.missed) c.id};
    return first;
  }

  void _calls(List<InboxItem> calls) {
    state = state.copyWith(calls: calls);
    final missed = state.missed;
    final known = _known;
    if (known == null) {
      _known = {for (final c in missed) c.id};
    } else {
      final fresh = missed.where((c) => !known.contains(c.id)).firstOrNull;
      known.addAll(missed.map((c) => c.id));
      if (fresh != null && _active && !_voiceLive) {
        _ring(fresh);
        return;
      }
    }
    // Answered elsewhere (the bed harvested, the message read): it stops by itself.
    final ringing = state.ringing;
    if (ringing != null && !missed.any((c) => c.id == ringing.id)) _endRing();
  }

  void _ring(InboxItem call) {
    _stopBell();
    if (!ref.read(phoneOpenProvider)) {
      _openedByRing = true;
      ref.read(phoneOpenProvider.notifier).set(true);
    }
    state = state.copyWith(ringing: () => call);
    Sfx.play('ring');
    _again = Timer.periodic(ringEvery, (_) => Sfx.play('ring'));
    _giveUp = Timer(ringFor, _endRing);
  }

  void _stopBell() {
    _again?.cancel();
    _giveUp?.cancel();
    _again = null;
    _giveUp = null;
  }

  /// The ring is over without an answer: the phone goes back to what it was.
  void _endRing() {
    _stopBell();
    if (state.ringing == null) return;
    state = state.copyWith(ringing: () => null);
    if (_openedByRing) {
      _openedByRing = false;
      ref.read(phoneOpenProvider.notifier).set(false);
    }
  }

  /// Stops the ring and keeps the phone up where it is (the home key while it rings).
  void silence() {
    _stopBell();
    _openedByRing = false;
    if (state.ringing != null) state = state.copyWith(ringing: () => null);
  }

  /// Answers or hangs up on a call (ringing, or from the missed list). Answering puts the phone away; the caller takes
  /// you where the call points.
  void settle(InboxItem call, {required bool answered}) {
    state = state.copyWith(
      handled: {...state.handled, call.id},
      log: [PhoneLogCall(call, answered: answered, at: DateTime.now()), ...state.log].take(_logKeep).toList(),
    );
    Sfx.play(answered ? 'voiceOn' : 'voiceOff');
    if (state.ringing?.id == call.id) {
      if (answered) {
        silence();
      } else {
        _endRing();
      }
    }
    if (answered) ref.read(phoneOpenProvider.notifier).set(false);
  }

  /// The voice call with the manager changed: no ringing while it is on, and it goes into the log when it ends.
  /// Repeating a phase is harmless, so the phone and its button may both report it.
  void voice({required bool live, required bool connected}) {
    final was = _voiceLive;
    _voiceLive = live;
    // The phone is up while the call is on, showing it.
    if (live && !was && !ref.read(phoneOpenProvider)) {
      _openedByVoice = true;
      ref.read(phoneOpenProvider.notifier).set(true);
    } else if (!live && was && _openedByVoice) {
      _openedByVoice = false;
      ref.read(phoneOpenProvider.notifier).set(false);
    }
    final now = DateTime.now();
    if (connected) {
      _voiceSince ??= now;
    } else if (!live && _voiceSince != null) {
      final from = _voiceSince!;
      _voiceSince = null;
      state = state.copyWith(
        log: [PhoneLogVoice(from: from, to: now), ...state.log].take(_logKeep).toList(),
      );
    }
  }

  /// Put away (the phone button, Esc, the handset's close): the ring stops with it.
  void putAway() {
    _openedByRing = false;
    _openedByVoice = false;
    _stopBell();
    if (state.ringing != null) state = state.copyWith(ringing: () => null);
  }
}
