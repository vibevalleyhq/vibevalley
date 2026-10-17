// The client never sees facts, only the folded frames.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';

class LogEntry {
  LogEntry(this.seq, this.type, this.at, this.summary, this._json);
  final int seq;

  final String type;
  final DateTime at;
  final String summary;
  final Map<String, dynamic> Function() _json;

  Map<String, dynamic> json() => _json();
}

class DebugLog {
  const DebugLog(this.entries, {this.paused = false});
  final List<LogEntry> entries;
  final bool paused;
}

const _keep = 2000;

final debugLogProvider = NotifierProvider<DebugLogNotifier, DebugLog>(DebugLogNotifier.new);

class DebugLogNotifier extends Notifier<DebugLog> {
  var _seq = 0;

  @override
  DebugLog build() {
    final server = ref.watch(serverProvider);
    final subs = [
      server.frames.listen((f) => _add('frame', frameSummary(f.frame), f.frame.toJson)),
      server.sideEvents.listen((e) => _add(sideType(e), sideSummary(e), e.toJson)),
    ];
    ref.onDispose(() {
      for (final s in subs) {
        unawaited(s.cancel());
      }
    });
    return const DebugLog([]);
  }

  void _add(String type, String summary, Map<String, dynamic> Function() json) {
    if (state.paused) return;
    final next = [...state.entries, LogEntry(++_seq, type, DateTime.now(), summary, json)];
    state = DebugLog(next.length > _keep ? next.sublist(next.length - _keep) : next, paused: state.paused);
  }

  void pause(bool paused) => state = DebugLog(state.entries, paused: paused);
  void clear() => state = DebugLog(const [], paused: state.paused);

  String export() => state.entries.map((e) => jsonEncode(e.json())).join('\n');
}

String sideType(SideEvent e) => switch (e) {
  SideEventSessionEvent() => 'step',
  SideEventNotice() => 'notice',
  SideEventRuntime() => 'runtime',
  SideEventSnapshot() => 'snapshot',
  Fact() => 'fact',
};

String _cut(String s, int n) => s.length > n ? s.substring(0, n) : s;

String frameSummary(StateFrame f) {
  final s = f.state;
  final sessions = s.sessions.map((h) => '${h.id}:${_phaseTag(h.phase)}').join(' ');
  final effects = f.effects.isEmpty ? '' : ' · ${f.effects.map((e) => e.toJson()['kind']).join(' ')}';
  return 'call=${s.call.wire} manager=${s.manager.wire} sessions=${sessions.isEmpty ? '0' : sessions}$effects';
}

String _phaseTag(Phase p) => switch (p) {
  PhaseArriving() => 'arriving',
  PhaseWorking() => 'working',
  PhaseRipe() => 'ripe',
  PhaseFailed() => 'failed',
  PhaseResting() => 'resting',
  PhaseClosed() => 'closed',
};

String sideSummary(SideEvent e) => switch (e) {
  SideEventSessionEvent(:final id, :final activity) => '$id #${activity.seq.round()} ${activity.type.wire}: ${_cut(activity.text, 80)}',
  SideEventNotice(:final level, :final text) => '${level.wire}: $text',
  SideEventRuntime(:final info) => '${info.id}: ${info.quota?.text ?? ''}',
  SideEventSnapshot() => 'snapshot',
  Fact() => e.toJson()['type'].toString(),
};
