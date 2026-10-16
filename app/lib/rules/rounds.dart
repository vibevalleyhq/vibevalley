// A trajectory as rounds of conversation (the farm's helper panel, desk/shared/work_log.dart): each round is what the
// helper was told (the job, a word, a comment on a step), what it did, and what it said back. And each round's time
// bar: one span per step, as long as the step took, coloured by what it was.

import '../gen/vibevalley.dart';

class Round {
  const Round(this.asked, this.steps);

  /// What started the round; null for steps before the first one (a trajectory whose start was dropped).
  final WorkStep? asked;

  /// What came after it, in order, sub-agents' steps included.
  final List<WorkStep> steps;

  /// What it said last in the round, its answer; null while it has said nothing.
  WorkStep? get answer {
    for (final s in steps.reversed) {
      if (s.kind == StepKind.said && s.under == null) return s;
    }
    return null;
  }

  List<WorkStep> get all => [?asked, ...steps];
}

/// The rounds of `steps`: a new one at each thing the helper itself was told (a sub-agent's are part of the call).
List<Round> roundsOf(List<WorkStep> steps) {
  final rounds = <Round>[];
  WorkStep? asked;
  var current = <WorkStep>[];
  for (final s in steps) {
    if (s.kind == StepKind.asked && s.under == null) {
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

/// One step on the bar: how long it took, in milliseconds.
class Span {
  const Span(this.step, this.ms);
  final WorkStep step;
  final double ms;
}

/// The round's bar: each step lasts until the next one starts; the last until `end` (now, while the round goes on;
/// else its own start).
List<Span> spansOf(Round round, {required double end}) {
  final all = round.all;
  return [for (var i = 0; i < all.length; i++) Span(all[i], ((i + 1 < all.length ? all[i + 1].at : end) - all[i].at).clamp(0, double.infinity).toDouble())];
}

/// How long a round took, from what started it to its last step (or `end`).
double roundMs(Round round, {required double end}) {
  final all = round.all;
  if (all.isEmpty) return 0;
  return (end - all.first.at).clamp(0, double.infinity).toDouble();
}

/// A duration as people say it: 8 秒, 3 分 20 秒, 1 小时 5 分.
String tookText(double ms) {
  final s = (ms / 1000).round();
  if (s < 60) return '$s 秒';
  final m = s ~/ 60;
  if (m < 60) return s % 60 == 0 ? '$m 分' : '$m 分 ${s % 60} 秒';
  return m % 60 == 0 ? '${m ~/ 60} 小时' : '${m ~/ 60} 小时 ${m % 60} 分';
}

/// The comments on each step, by the step's `n`: the steps it was told that name it (WorkStep.on).
Map<int, List<WorkStep>> commentsOf(List<WorkStep> steps) {
  final out = <int, List<WorkStep>>{};
  for (final s in steps) {
    if (s.kind == StepKind.asked && s.on != null) (out[s.on!.round()] ??= []).add(s);
  }
  return out;
}

/// What a comment says, without the step it quotes (runs/steps.go CommentText puts it after this head).
String commentWords(WorkStep asked) {
  const head = '\n\n我的评论：';
  final text = asked.text;
  final at = text.lastIndexOf(head);
  return at < 0 ? text : text.substring(at + head.length).trim();
}
