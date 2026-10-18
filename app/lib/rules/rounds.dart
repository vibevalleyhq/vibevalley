import '../gen/vibevalley.dart';

/// The log as the work log shows it: a call with its result's output and ok, the results and the run bounds left out (a
/// run is where the rounds split). The log itself only grows: a result is an event of its own.
List<SessionEvent> shownEvents(List<SessionEvent> log) {
  final results = {
    for (final e in log)
      if (e.type == SessionEventType.toolResult && e.call != null) e.call!: e,
  };
  return [
    for (final e in log)
      if (e.type == SessionEventType.toolCall && results[e.seq] != null)
        SessionEvent.fromJson({...e.toJson(), 'output': results[e.seq]!.output, 'ok': results[e.seq]!.ok})
      else if (e.type != SessionEventType.toolResult && e.type != SessionEventType.runStart && e.type != SessionEventType.runEnd)
        e,
  ];
}

class Round {
  const Round(this.asked, this.steps);

  /// null for steps before the first one (a trajectory whose start was dropped).
  final SessionEvent? asked;

  final List<SessionEvent> steps;

  /// null while it has said nothing.
  SessionEvent? get answer {
    for (final s in steps.reversed) {
      if (s.type == SessionEventType.assistantMessage && s.under == null) return s;
    }
    return null;
  }

  List<SessionEvent> get all => [?asked, ...steps];
}

/// A sub-agent's told steps are part of the call.
List<Round> roundsOf(List<SessionEvent> steps) {
  final rounds = <Round>[];
  SessionEvent? asked;
  var current = <SessionEvent>[];
  for (final s in steps) {
    if (s.type == SessionEventType.userMessage && s.under == null) {
      if (asked != null || current.isNotEmpty) rounds.add(Round(asked, current));
      asked = s;
      current = [];
    } else {
      current.add(s);
    }
  }
  if (asked != null || current.isNotEmpty) rounds.add(Round(asked, current));
  return rounds;
}

class Span {
  const Span(this.step, this.ms);
  final SessionEvent step;
  final double ms;
}

/// Each step lasts until the next one starts; the last until `end` (now, while the round goes on; else its own start).
List<Span> spansOf(Round round, {required double end}) {
  final all = round.all;
  return [for (var i = 0; i < all.length; i++) Span(all[i], ((i + 1 < all.length ? all[i + 1].time : end) - all[i].time).clamp(0, double.infinity).toDouble())];
}

double roundMs(Round round, {required double end}) {
  final all = round.all;
  if (all.isEmpty) return 0;
  return (end - all.first.time).clamp(0, double.infinity).toDouble();
}

String tookText(double ms) {
  final s = (ms / 1000).round();
  if (s < 60) return '$s 秒';
  final m = s ~/ 60;
  if (m < 60) return s % 60 == 0 ? '$m 分' : '$m 分 ${s % 60} 秒';
  return m % 60 == 0 ? '${m ~/ 60} 小时' : '${m ~/ 60} 小时 ${m % 60} 分';
}
