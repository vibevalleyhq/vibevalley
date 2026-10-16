// What a helper's turn is reminded of from its agent's memory (server/internal/protocol/recall.go), ported to Dart: the
// server picks it at the start of each turn, and the agent page shows the same pick ahead of time. Pure functions, kept
// in step with the Go rule: test/recall_parity_test.dart checks pick against the cases Go writes to schema/recall.sample.json.

import 'dart:math' as math;

import '../../gen/vibevalley.dart';

/// What a turn is reminded of: this many memories (this many of them jobs) in this many characters, at most.
const recallCount = 8;
const recallJobs = 3;
const recallChars = 1600;

/// Memories an agent keeps; past this, the ones longest unused go.
const memoryKeep = 300;

const _stop = {
  '一个', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '什么', '没有', '就是', '不是', '然后', '如果', '因为', '所以', '已经', //
  '还是', '这样', '时候', '一下', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'you', 'to', 'of', 'in', 'is', 'it',
  'on',
};

final _latin = RegExp(r'[a-z0-9_][a-z0-9_.\-/]*');
final _han = RegExp(r'[㐀-鿿]+');

/// What a text is about, as terms: Latin words and numbers in lower case, and each pair of Chinese characters in a row.
Set<String> termsOf(String text) {
  final terms = <String>{};
  // İ lowers to i and a combining dot, as in the Go rule (JavaScript's toLowerCase); the Dart VM's gives a bare i.
  for (final m in _latin.allMatches(text.replaceAll('İ', 'i\u0307').toLowerCase())) {
    final word = m[0]!;
    if (word.length >= 2 && !_stop.contains(word)) terms.add(word);
  }
  for (final m in _han.allMatches(text)) {
    final run = m[0]!;
    for (var i = 0; i + 1 < run.length; i++) {
      final pair = run.substring(i, i + 2);
      if (!_stop.contains(pair)) terms.add(pair);
    }
  }
  return terms;
}

int termsInCommon(Set<String> a, Set<String> b) => a.where(b.contains).length;

/// A turn about to start, as recall sees it.
class Cue {
  const Cue({required this.helper, required this.project, required this.text, this.skip = const {}, required this.now});

  /// The helper about to work: what it left itself is in its own session already.
  final String helper;
  final String project;

  /// What the turn is asked.
  final String text;

  /// Memories already brought into its session.
  final Set<String> skip;
  final num now;
}

const _day = 86400000;

/// Words in common that make another project's note worth bringing.
const _elsewhere = 3;

/// How much a memory bears on a turn; null when it does not.
double? relevance(Memory m, Cue cue, Set<String> terms) {
  if (cue.skip.contains(m.id) || m.helper == cue.helper) return null;
  final shared = termsInCommon(termsOf(m.text), terms);
  final here = m.project == cue.project;
  final everywhere = m.project == null;
  if (m.kind == MemoryKind.job ? !here : !here && !everywhere && shared < _elsewhere) return null;
  final age = math.max(0, cue.now - (m.recalledAt ?? m.at)) / _day;
  return (m.kind == MemoryKind.note ? 2 : 0.5) + (here ? 2 : (everywhere ? 1 : 0)) + math.min(shared, 8) * 0.4 + math.exp(-age / 30);
}

/// A memory as a line of the reminder.
String lineOf(Memory m, String project) {
  final where = m.project == null ? '所有项目' : (m.project == project ? '这个项目' : '项目 ${m.project}');
  return m.kind == MemoryKind.job ? '- 做过（$where）：${m.text}' : '- （$where）${m.text}';
}

/// The memories a turn is reminded of: the most relevant first, within recallCount, recallJobs and recallChars.
List<Memory> pick(List<Memory> memories, Cue cue) {
  final terms = termsOf(cue.text);
  final ranked = <({Memory m, double score, int i})>[];
  for (var i = 0; i < memories.length; i++) {
    final score = relevance(memories[i], cue, terms);
    if (score != null) ranked.add((m: memories[i], score: score, i: i));
  }
  // The index keeps it stable, as JavaScript's sort is.
  ranked.sort((a, b) {
    final by = b.score.compareTo(a.score);
    if (by != 0) return by;
    final at = b.m.at.compareTo(a.m.at);
    return at != 0 ? at : a.i.compareTo(b.i);
  });
  final picked = <Memory>[];
  var chars = 0;
  var jobs = 0;
  for (final r in ranked) {
    if (picked.length == recallCount) break;
    final length = lineOf(r.m, cue.project).length + 1;
    if ((r.m.kind == MemoryKind.job && jobs == recallJobs) || chars + length > recallChars) continue;
    picked.add(r.m);
    chars += length;
    if (r.m.kind == MemoryKind.job) jobs++;
  }
  return picked;
}

/// The memories that go first when the agent keeps more than memoryKeep and its helpers add `coming` more: the
/// longest unused (last recalled, else written).
Set<String> nextForgotten(List<Memory> memories, int coming) {
  final over = memories.length + coming - memoryKeep;
  if (over <= 0) return {};
  final indexed = [for (var i = 0; i < memories.length; i++) (m: memories[i], i: i)]
    ..sort((a, b) {
      final by = (a.m.recalledAt ?? a.m.at).compareTo(b.m.recalledAt ?? b.m.at);
      return by != 0 ? by : a.i.compareTo(b.i);
    });
  return {for (final x in indexed.take(over)) x.m.id};
}
