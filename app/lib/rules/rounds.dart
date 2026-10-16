import '../gen/vibevalley.dart';

class Round {
  const Round(this.asked, this.steps);

  /// null for steps before the first one (a trajectory whose start was dropped).
  final WorkStep? asked;

  final List<WorkStep> steps;

  /// null while it has said nothing.
  WorkStep? get answer {
    for (final s in steps.reversed) {
      if (s.kind == StepKind.said && s.under == null) return s;
    }
    return null;
  }

  List<WorkStep> get all => [?asked, ...steps];
}

/// A sub-agent's told steps are part of the call.
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

class Span {
  const Span(this.step, this.ms);
  final WorkStep step;
  final double ms;
}

/// Each step lasts until the next one starts; the last until `end` (now, while the round goes on; else its own start).
List<Span> spansOf(Round round, {required double end}) {
  final all = round.all;
  return [for (var i = 0; i < all.length; i++) Span(all[i], ((i + 1 < all.length ? all[i + 1].at : end) - all[i].at).clamp(0, double.infinity).toDouble())];
}

double roundMs(Round round, {required double end}) {
  final all = round.all;
  if (all.isEmpty) return 0;
  return (end - all.first.at).clamp(0, double.infinity).toDouble();
}

String tookText(double ms) {
  final s = (ms / 1000).round();
  if (s < 60) return '$s 秒';
  final m = s ~/ 60;
  if (m < 60) return s % 60 == 0 ? '$m 分' : '$m 分 ${s % 60} 秒';
  return m % 60 == 0 ? '${m ~/ 60} 小时' : '${m ~/ 60} 小时 ${m % 60} 分';
}

Map<int, List<WorkStep>> commentsOf(List<WorkStep> steps) {
  final out = <int, List<WorkStep>>{};
  for (final s in steps) {
    if (s.kind == StepKind.asked && s.on != null) (out[s.on!.round()] ??= []).add(s);
  }
  return out;
}

/// runs/steps.go CommentText puts the comment after this head.
String commentWords(WorkStep asked) {
  const head = '\n\n我的评论：';
  final text = asked.text;
  final at = text.lastIndexOf(head);
  return at < 0 ? text : text.substring(at + head.length).trim();
}
