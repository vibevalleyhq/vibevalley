// The calls are the server's inbox; which were answered or hung up on, the call log, and which rings now are the client's, kept for this session only.

import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../audio/sfx.dart';
import 'phone.dart' show phoneOpenProvider;

String inboxKindLabel(InboxKind kind) => switch (kind) {
  InboxKind.merge => '活熟了',
  InboxKind.fix => '活没做成',
  InboxKind.conflict => '合不进去',
  InboxKind.quiet => '好久没动静',
  InboxKind.planDraft => '计划拆好了',
  InboxKind.planRipe => '计划能收了',
  InboxKind.planFailed => '计划卡住了',
  InboxKind.mention => '找你',
};

List<InboxItem> unansweredCalls(List<InboxItem> calls, Set<String> handled) => [
  for (final c in calls)
    if (!handled.contains(c.id)) c,
];

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

  final List<InboxItem> calls;

  final Set<String> handled;

  final InboxItem? ringing;

  final List<PhoneLogEntry> log;

  List<InboxItem> get missed => unansweredCalls(calls, handled);

  PhoneState copyWith({List<InboxItem>? calls, Set<String>? handled, InboxItem? Function()? ringing, List<PhoneLogEntry>? log}) =>
      PhoneState(calls: calls ?? this.calls, handled: handled ?? this.handled, ringing: ringing == null ? this.ringing : ringing(), log: log ?? this.log);
}

const ringFor = Duration(seconds: 20);
const ringEvery = Duration(seconds: 4);
const _logKeep = 40;

final phoneProvider = NotifierProvider<PhoneCalls, PhoneState>(PhoneCalls.new);

class PhoneCalls extends Notifier<PhoneState> {
  /// null until the farm screen's first look, which rings nothing.
  Set<String>? _known;
  bool _active = true;
  bool _voiceLive = false;
  DateTime? _voiceSince;

  bool _openedByRing = false;

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

  void _endRing() {
    _stopBell();
    if (state.ringing == null) return;
    state = state.copyWith(ringing: () => null);
    if (_openedByRing) {
      _openedByRing = false;
      ref.read(phoneOpenProvider.notifier).set(false);
    }
  }

  void silence() {
    _stopBell();
    _openedByRing = false;
    if (state.ringing != null) state = state.copyWith(ringing: () => null);
  }

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

  /// Repeating a phase is harmless, so the phone and its button may both report it.
  void voice({required bool live, required bool connected}) {
    final was = _voiceLive;
    _voiceLive = live;
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

  void putAway() {
    _openedByRing = false;
    _openedByVoice = false;
    _stopBell();
    if (state.ringing != null) state = state.copyWith(ringing: () => null);
  }
}
