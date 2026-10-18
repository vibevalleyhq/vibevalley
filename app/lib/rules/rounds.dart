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

enum Lane { asked, model, tool }

/// A stretch of one lane of the waterfall; `seq` is the shown row it opens.
class LaneSpan {
  const LaneSpan(this.lane, this.start, this.end, this.seq);
  final Lane lane;
  final double start;
  final double end;
  final double seq;
  double get ms => end - start;
}

class Waterfall {
  const Waterfall(this.rounds, this.spans);

  /// Each round's first and last time: the idle time between rounds is not drawn.
  final List<(double, double)> rounds;
  final List<LaneSpan> spans;
}

/// Lanes from the times the log already has; a step's time is when it began. A model answer runs from what it answered
/// (the message, a tool's result) to its llm/usage, or, with none, to the last step before what stops it; a tool from its
/// call to its result. `end` is where the last round stops (now, while it goes on).
Waterfall waterfallOf(List<SessionEvent> log, {required double end}) {
  final top = [
    for (final e in log)
      if (e.under == null && e.type != SessionEventType.runStart && e.type != SessionEventType.runEnd) e,
  ];
  final groups = <List<SessionEvent>>[];
  for (final e in top) {
    if (groups.isEmpty || (e.type == SessionEventType.userMessage && groups.last.isNotEmpty)) groups.add([]);
    groups.last.add(e);
  }
  final rounds = <(double, double)>[];
  final spans = <LaneSpan>[];
  for (var g = 0; g < groups.length; g++) {
    final steps = groups[g];
    final from = steps.first.time;
    final to = g == groups.length - 1 && end > steps.last.time ? end : steps.last.time;
    rounds.add((from, to));
    final calls = <double, double>{};
    var waiting = from;
    (double, double)? open;
    var prev = from;
    void close(double at) {
      if (open case (final start, final seq)) spans.add(LaneSpan(Lane.model, start, at < start ? start : at, seq));
      open = null;
    }

    for (var i = 0; i < steps.length; i++) {
      final e = steps[i];
      switch (e.type) {
        case SessionEventType.userMessage:
          spans.add(LaneSpan(Lane.asked, e.time, i + 1 < steps.length ? steps[i + 1].time : to, e.seq));
          waiting = e.time;
        case SessionEventType.assistantThinking || SessionEventType.assistantMessage || SessionEventType.toolCall:
          open ??= (waiting, e.seq);
          if (e.type == SessionEventType.toolCall) calls[e.seq] = e.time;
        case SessionEventType.llmUsage:
          close(e.time);
          waiting = e.time;
        case SessionEventType.toolResult:
          close(prev);
          if (e.call case final call? when calls.containsKey(call)) spans.add(LaneSpan(Lane.tool, calls.remove(call)!, e.time, call));
          waiting = e.time;
        case SessionEventType.memoryRecalled:
          if (open == null) waiting = e.time;
        case SessionEventType.runError:
          close(e.time);
          waiting = e.time;
        case SessionEventType.llmRetry || SessionEventType.runStart || SessionEventType.runEnd:
          break;
      }
      prev = e.time;
    }
    close(to);
    for (final MapEntry(key: seq, value: start) in calls.entries) {
      spans.add(LaneSpan(Lane.tool, start, to, seq));
    }
  }
  return Waterfall(rounds, spans);
}

class TrajectorySummary {
  const TrajectorySummary({
    required this.rounds,
    required this.steps,
    required this.modelMs,
    required this.toolMs,
    required this.input,
    required this.cacheRead,
    required this.output,
  });
  final int rounds;
  final int steps;
  final double modelMs;
  final double toolMs;

  /// The prompt's tokens not read from the cache, as llm/usage counts them.
  final int input;
  final int cacheRead;
  final int output;

  /// null with no usage recorded.
  double? get cacheHit => input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null;
}

/// The footer's numbers: rows other than llm/usage are steps; tokens are every llm/usage's, a sub-agent's too.
TrajectorySummary summaryOf(List<SessionEvent> log, {required double end}) {
  final shown = shownEvents(log);
  final lanes = waterfallOf(log, end: end).spans;
  double sum(Lane lane) => lanes.where((s) => s.lane == lane).fold(0, (n, s) => n + s.ms);
  var (input, cacheRead, output) = (0, 0, 0);
  for (final e in log) {
    if (e.tokens case final t?) {
      input += t.input.round();
      cacheRead += t.cacheRead.round();
      output += t.output.round();
    }
  }
  return TrajectorySummary(
    rounds: roundsOf(shown).length,
    steps: shown.where((e) => e.type != SessionEventType.llmUsage).length,
    modelMs: sum(Lane.model),
    toolMs: sum(Lane.tool),
    input: input,
    cacheRead: cacheRead,
    output: output,
  );
}

/// Under ten seconds to a tenth.
String secondsText(double ms) => ms < 10000 ? '${(ms / 1000).toStringAsFixed(1)} 秒' : tookText(ms);

String tokensText(int n) => n < 10000 ? '$n' : '${(n / 10000).toStringAsFixed(1)} 万';
