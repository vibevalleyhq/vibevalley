import '../gen/vibevalley.dart';

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

Map<int, List<SessionEvent>> commentsOf(List<SessionEvent> steps) {
  final out = <int, List<SessionEvent>>{};
  for (final s in steps) {
    if (s.type == SessionEventType.userMessage && s.on != null) (out[s.on!.round()] ??= []).add(s);
  }
  return out;
}

/// session/activities.go CommentText puts the comment after this head.
String commentWords(SessionEvent asked) {
  const head = '\n\n我的评论：';
  final text = asked.text;
  final at = text.lastIndexOf(head);
  return at < 0 ? text : text.substring(at + head.length).trim();
}
