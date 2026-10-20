import '../gen/vibevalley.dart';

// What the document editor computes on its own: order keys for the blocks it inserts, offsets in the server's unit,
// marks kept through an edit, list numbers and the line-start shortcuts. The ops' rules stay the server's (internal/doc).

const _digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/// Base62, never ending in '0'; the same keys internal/doc/order.go makes.
bool validKey(String k) => k.isNotEmpty && k.length <= 256 && !k.endsWith('0') && k.split('').every(_digits.contains);

/// A key after [a] and before [b]; '' for a is the start, '' for b the end.
String keyBetween(String a, String b) {
  if ((a.isNotEmpty && !validKey(a)) || (b.isNotEmpty && !validKey(b)) || (a.isNotEmpty && b.isNotEmpty && a.compareTo(b) >= 0)) {
    throw ArgumentError('no key between $a and $b');
  }
  if (b.isEmpty) return a.isEmpty ? 'V' : _stepUp(a);
  if (a.isEmpty) return _before(b);
  return _midpoint(a, b);
}

String _stepUp(String a) {
  if (a.isEmpty) return '1';
  final i = _digits.indexOf(a[0]);
  if (i < _digits.length - 1) return _digits[i + 1];
  return a[0] + _stepUp(a.substring(1));
}

String _before(String b) {
  final i = _digits.indexOf(b[0]);
  if (i > 1) return _digits[i - 1];
  if (i == 1) return '0z';
  return '0${_before(b.substring(1))}';
}

String _midpoint(String a, String b) {
  if (b.isNotEmpty) {
    var n = 0;
    while (n < b.length && (n < a.length ? a[n] : '0') == b[n]) {
      n++;
    }
    if (n > 0) return b.substring(0, n) + _midpoint(n < a.length ? a.substring(n) : '', b.substring(n));
  }
  final lo = a.isEmpty ? 0 : _digits.indexOf(a[0]);
  final hi = b.isEmpty ? _digits.length : _digits.indexOf(b[0]);
  if (hi - lo > 1) return _digits[(lo + hi + 1) ~/ 2];
  if (b.length > 1) return b.substring(0, 1);
  return _digits[lo] + _midpoint(a.length > 1 ? a.substring(1) : '', '');
}

/// The server counts offsets in code points; a Dart string's index is in UTF-16 units.
int codePointOffset(String text, int utf16) => text.substring(0, utf16.clamp(0, text.length)).runes.length;

String plainOf(List<DocSpan> spans) => spans.map((s) => s.t).join();

bool sameMarks(DocMarks a, DocMarks b) =>
    (a.bold ?? false) == (b.bold ?? false) &&
    (a.italic ?? false) == (b.italic ?? false) &&
    (a.code ?? false) == (b.code ?? false) &&
    (a.strike ?? false) == (b.strike ?? false) &&
    a.link == b.link;

List<DocSpan> normalSpans(Iterable<DocSpan> spans) {
  final out = <DocSpan>[];
  for (final s in spans) {
    if (s.t.isEmpty) continue;
    if (out.isNotEmpty && sameMarks(out.last.marks, s.marks)) {
      out[out.length - 1] = DocSpan(t: out.last.t + s.t, marks: s.marks);
    } else {
      out.add(s);
    }
  }
  return out;
}

/// Spans cut at a UTF-16 index of their text.
(List<DocSpan>, List<DocSpan>) splitSpans(List<DocSpan> spans, int at) {
  final left = <DocSpan>[], right = <DocSpan>[];
  for (final s in spans) {
    if (at <= 0) {
      right.add(s);
    } else if (at >= s.t.length) {
      left.add(s);
    } else {
      left.add(DocSpan(t: s.t.substring(0, at), marks: s.marks));
      right.add(DocSpan(t: s.t.substring(at), marks: s.marks));
    }
    at -= s.t.length;
  }
  return (normalSpans(left), normalSpans(right));
}

bool _low(int unit) => unit >= 0xDC00 && unit <= 0xDFFF;

/// The spans after the text became [text]: what is the same at both ends keeps its marks; what was typed takes the marks
/// of the character before it, a link's excepted.
List<DocSpan> editSpans(List<DocSpan> old, String text) {
  final before = plainOf(old);
  if (before == text) return old;
  var p = 0;
  while (p < before.length && p < text.length && before.codeUnitAt(p) == text.codeUnitAt(p)) {
    p++;
  }
  if (p > 0 && p < text.length && _low(text.codeUnitAt(p))) p--;
  var s = 0;
  while (s < before.length - p && s < text.length - p && before.codeUnitAt(before.length - 1 - s) == text.codeUnitAt(text.length - 1 - s)) {
    s++;
  }
  if (s > 0 && _low(text.codeUnitAt(text.length - s))) s--;
  final (head, rest) = splitSpans(old, p);
  final (_, tail) = splitSpans(rest, before.length - p - s);
  final typed = text.substring(p, text.length - s);
  var marks = const DocMarks();
  if (head.isNotEmpty) {
    final m = head.last.marks;
    marks = DocMarks(bold: m.bold, italic: m.italic, code: m.code, strike: m.strike);
  }
  return normalSpans([...head, DocSpan(t: typed, marks: marks), ...tail]);
}

const textTypes = {blockParagraph, blockHeading, blockBulleted, blockNumbered, blockTodo, blockQuote, blockCode, blockMemoryItem};
const knownTypes = {...textTypes, blockDivider, blockImage, blockIssueRef};
const listTypes = {blockBulleted, blockNumbered, blockTodo};

bool hasText(String type) => textTypes.contains(type);

/// A paragraph that starts with Markdown for another block: its type, its attrs, and how much of the start to drop.
({String type, BlockAttrs attrs, int strip})? markdownShortcut(String text) {
  final heading = RegExp(r'^(#{1,3}) ').firstMatch(text);
  if (heading != null) return (type: blockHeading, attrs: BlockAttrs(level: heading[1]!.length.toDouble()), strip: heading[0]!.length);
  final todo = RegExp(r'^\[( |x)?\] ').firstMatch(text);
  if (todo != null) return (type: blockTodo, attrs: BlockAttrs(checked: todo[1] == 'x'), strip: todo[0]!.length);
  final bullet = RegExp(r'^[-*] ').firstMatch(text);
  if (bullet != null) return (type: blockBulleted, attrs: const BlockAttrs(), strip: bullet[0]!.length);
  final number = RegExp(r'^\d+[.)] ').firstMatch(text);
  if (number != null) return (type: blockNumbered, attrs: const BlockAttrs(), strip: number[0]!.length);
  if (text.startsWith('> ')) return (type: blockQuote, attrs: const BlockAttrs(), strip: 2);
  if (text.startsWith('```')) return (type: blockCode, attrs: const BlockAttrs(), strip: text.startsWith('``` ') ? 4 : 3);
  return null;
}

/// Each numbered block's number: its place in the run of numbered siblings it is in. [ordered] is the document's order,
/// each block followed by its children.
Map<String, int> listNumbers(List<({String id, String? parentId, String type})> ordered) {
  final last = <String?, (String, int)>{};
  final out = <String, int>{};
  for (final b in ordered) {
    final before = last[b.parentId];
    final n = b.type == blockNumbered ? (before != null && before.$1 == blockNumbered ? before.$2 + 1 : 1) : 0;
    last[b.parentId] = (b.type, n);
    if (b.type == blockNumbered) out[b.id] = n;
  }
  return out;
}
