// GitHub-flavoured, no raw HTML. Colours follow the surrounding text colour, so the same rules read on cream paper and on a green bubble.

const mentionHref = '#mention';

final _codeParts = RegExp(r'(```[\s\S]*?```|`[^`\n]*`)');

final _mention = RegExp(r'(^|[^\p{L}\p{N}_@])@(w\d+|管家|主人|所有人)', unicode: true);

/// Outside code, as the group chat reads them (protocol MentionsIn).
String withMentions(String text) {
  final out = StringBuffer();
  var at = 0;
  for (final m in _codeParts.allMatches(text)) {
    out
      ..write(_mentionLinks(text.substring(at, m.start)))
      ..write(m[0]);
    at = m.end;
  }
  out.write(_mentionLinks(text.substring(at)));
  return out.toString();
}

String _mentionLinks(String s) => s.replaceAllMapped(_mention, (m) => '${m[1]}[@${m[2]}]($mentionHref)');

String plainText(String markdown) => markdown
    .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
    .replaceAllMapped(RegExp(r'`([^`]*)`'), (m) => m[1]!)
    .replaceAllMapped(RegExp(r'!?\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!)
    .replaceAll(RegExp(r'^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+', multiLine: true), '')
    .replaceAllMapped(RegExp(r'(\*\*|__|\*|_|~~)(.+?)\1'), (m) => m[2]!)
    .replaceAll('|', ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

sealed class MdBlock {
  const MdBlock();
}

final class MdParagraph extends MdBlock {
  const MdParagraph(this.text);
  final String text;
}

final class MdHeading extends MdBlock {
  const MdHeading(this.level, this.text);
  final int level;
  final String text;
}

final class MdCode extends MdBlock {
  const MdCode(this.text, this.lang);
  final String text;
  final String lang;
}

final class MdQuote extends MdBlock {
  const MdQuote(this.children);
  final List<MdBlock> children;
}

final class MdItem {
  const MdItem(this.children, {this.checked});
  final List<MdBlock> children;

  final bool? checked;
}

final class MdList extends MdBlock {
  const MdList({required this.ordered, required this.start, required this.items, required this.tight});
  final bool ordered;
  final int start;
  final List<MdItem> items;

  /// No blank lines between or inside the items: their text is not set as paragraphs.
  final bool tight;
}

final class MdRule extends MdBlock {
  const MdRule();
}

enum MdAlign { none, left, center, right }

final class MdTable extends MdBlock {
  const MdTable(this.header, this.aligns, this.rows);
  final List<String> header;
  final List<MdAlign> aligns;
  final List<List<String>> rows;
}

final _fence = RegExp(r'^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)');

final _heading = RegExp(r'^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$');

final _rule = RegExp(r'^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$');

final _quote = RegExp(r'^ {0,3}> ?');

final _bullet = RegExp(r'^( {0,3})([-*+])([ \t]+|$)');

final _ordered = RegExp(r'^( {0,3})(\d{1,9})([.)])([ \t]+|$)');

final _setext = RegExp(r'^ {0,3}(=+|-+)[ \t]*$');

final _delimiter = RegExp(r'^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$');

final _task = RegExp(r'^\[([ xX])\][ \t]+');

bool _blank(String l) => l.trim().isEmpty;

List<String> _cells(String row) {
  var r = row.trim();
  if (r.startsWith('|')) r = r.substring(1);
  if (r.endsWith('|') && !r.endsWith(r'\|')) r = r.substring(0, r.length - 1);
  final cells = <String>[];
  final cell = StringBuffer();
  for (var i = 0; i < r.length; i++) {
    if (r[i] == r'\' && i + 1 < r.length && r[i + 1] == '|') {
      cell.write('|');
      i++;
    } else if (r[i] == '|') {
      cells.add(cell.toString().trim());
      cell.clear();
    } else {
      cell.write(r[i]);
    }
  }
  cells.add(cell.toString().trim());
  return cells;
}

bool _tableAt(List<String> lines, int i) =>
    i + 1 < lines.length && lines[i].contains('|') && _delimiter.hasMatch(lines[i + 1]) && _cells(lines[i]).length == _cells(lines[i + 1]).length;

bool _interrupts(List<String> lines, int i) {
  final l = lines[i];
  if (_fence.hasMatch(l) || _heading.hasMatch(l) || _rule.hasMatch(l) || _quote.hasMatch(l) || _tableAt(lines, i)) return true;
  final b = _bullet.firstMatch(l);
  if (b != null && l.substring(b.end).trim().isNotEmpty) return true;
  final o = _ordered.firstMatch(l);
  return o != null && o[2] == '1' && l.substring(o.end).trim().isNotEmpty;
}

List<MdBlock> parseMarkdown(String text) => _blocks(text.replaceAll('\r\n', '\n').replaceAll('\t', '    ').split('\n'));

List<MdBlock> _blocks(List<String> lines) {
  final out = <MdBlock>[];
  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    if (_blank(line)) {
      i++;
      continue;
    }
    final fence = _fence.firstMatch(line);
    if (fence != null) {
      final indent = fence[1]!.length;
      final mark = fence[2]!;
      final body = <String>[];
      i++;
      while (i < lines.length) {
        final l = lines[i];
        final t = l.trimLeft();
        if (t.startsWith(mark[0] * mark.length) && t.replaceAll(mark[0], '').trim().isEmpty && l.length - t.length < 4) {
          i++;
          break;
        }
        var cut = 0;
        while (cut < indent && cut < l.length && l[cut] == ' ') {
          cut++;
        }
        body.add(l.substring(cut));
        i++;
      }
      out.add(MdCode(body.join('\n'), fence[3]!));
      continue;
    }
    final heading = _heading.firstMatch(line);
    if (heading != null) {
      out.add(MdHeading(heading[1]!.length, (heading[2] ?? '').trim()));
      i++;
      continue;
    }
    if (_rule.hasMatch(line)) {
      out.add(const MdRule());
      i++;
      continue;
    }
    if (_quote.hasMatch(line)) {
      final body = <String>[];
      while (i < lines.length && _quote.hasMatch(lines[i])) {
        body.add(lines[i].replaceFirst(_quote, ''));
        i++;
      }
      out.add(MdQuote(_blocks(body)));
      continue;
    }
    if (_bullet.hasMatch(line) || _ordered.hasMatch(line)) {
      i = _list(lines, i, out);
      continue;
    }
    if (_tableAt(lines, i)) {
      final header = _cells(line);
      final aligns = [
        for (final c in _cells(lines[i + 1]))
          c.startsWith(':') && c.endsWith(':')
              ? MdAlign.center
              : c.endsWith(':')
              ? MdAlign.right
              : c.startsWith(':')
              ? MdAlign.left
              : MdAlign.none,
      ];
      i += 2;
      final rows = <List<String>>[];
      while (i < lines.length && !_blank(lines[i]) && !(_interrupts(lines, i) && !lines[i].contains('|'))) {
        final cells = _cells(lines[i]);
        rows.add([for (var c = 0; c < header.length; c++) c < cells.length ? cells[c] : '']);
        i++;
      }
      out.add(MdTable(header, aligns, rows));
      continue;
    }
    final para = <String>[line.trimLeft()];
    i++;
    while (i < lines.length && !_blank(lines[i])) {
      final setext = _setext.firstMatch(lines[i]);
      if (setext != null) {
        out.add(MdHeading(setext[1]!.startsWith('=') ? 1 : 2, para.join('\n').trim()));
        para.clear();
        i++;
        break;
      }
      if (_interrupts(lines, i)) break;
      para.add(lines[i].trimLeft());
      i++;
    }
    if (para.isNotEmpty) out.add(MdParagraph(para.join('\n')));
  }
  return out;
}

int _list(List<String> lines, int start, List<MdBlock> out) {
  final first = lines[start];
  final bullet = _bullet.firstMatch(first);
  final ordered = bullet == null;
  final marker = bullet?[2] ?? _ordered.firstMatch(first)![3]!;
  final number = ordered ? int.parse(_ordered.firstMatch(first)![2]!) : 1;
  final items = <MdItem>[];
  var tight = true;
  var i = start;

  (int, int)? itemAt(String l) {
    if (ordered) {
      final m = _ordered.firstMatch(l);
      if (m == null || m[3] != marker) return null;
      final pad = m[4]!.isEmpty ? 1 : (m[4]!.length > 4 ? 1 : m[4]!.length);
      return (m.end - m[4]!.length, m.end - m[4]!.length + pad);
    }
    final m = _bullet.firstMatch(l);
    if (m == null || m[2] != marker || _rule.hasMatch(l)) return null;
    final pad = m[3]!.isEmpty ? 1 : (m[3]!.length > 4 ? 1 : m[3]!.length);
    return (m.end - m[3]!.length, m.end - m[3]!.length + pad);
  }

  while (i < lines.length) {
    final at = itemAt(lines[i]);
    if (at == null) break;
    final (_, content) = at;
    final body = <String>[lines[i].length > content ? lines[i].substring(content) : ''];
    i++;
    var sawBlank = false;
    while (i < lines.length) {
      final l = lines[i];
      if (_blank(l)) {
        body.add('');
        sawBlank = true;
        i++;
        continue;
      }
      final indent = l.length - l.trimLeft().length;
      if (indent >= content) {
        if (sawBlank) tight = false;
        body.add(l.substring(content));
        sawBlank = false;
        i++;
        continue;
      }
      // A lazy continuation of the item's paragraph.
      if (!sawBlank && itemAt(l) == null && !_interrupts(lines, i) && !_bullet.hasMatch(l) && !_ordered.hasMatch(l)) {
        body.add(l.trimLeft());
        i++;
        continue;
      }
      break;
    }
    // Trailing blank lines separate items (a loose list) only when another item follows.
    while (body.isNotEmpty && _blank(body.last)) {
      body.removeLast();
    }
    if (sawBlank && i < lines.length && itemAt(lines[i]) != null) tight = false;
    bool? checked;
    final graph = _task.firstMatch(body.first);
    if (graph != null) {
      checked = graph[1] != ' ';
      body[0] = body.first.substring(graph.end);
    }
    items.add(MdItem(_blocks(body), checked: checked));
    if (sawBlank && (i >= lines.length || itemAt(lines[i]) == null)) break;
  }
  out.add(MdList(ordered: ordered, start: number, items: items, tight: tight));
  return i;
}

sealed class MdInline {
  const MdInline();
}

final class MdText extends MdInline {
  const MdText(this.text);
  final String text;
}

final class MdCodeSpan extends MdInline {
  const MdCodeSpan(this.text);
  final String text;
}

final class MdStyled extends MdInline {
  const MdStyled(this.kind, this.children);

  final String kind;
  final List<MdInline> children;
}

final class MdLink extends MdInline {
  const MdLink(this.href, this.children);
  final String href;
  final List<MdInline> children;
}

final class MdBreak extends MdInline {
  const MdBreak();
}

const _punct = r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''';

final _url = RegExp(r'''^(?:https?://|www\.)[^\s<]*''');

final _wordChar = RegExp(r'[\p{L}\p{N}]', unicode: true);

List<MdInline> parseInline(String s) {
  final out = <MdInline>[];
  final text = StringBuffer();
  void flush() {
    if (text.isNotEmpty) out.add(MdText(text.toString()));
    text.clear();
  }

  var i = 0;
  while (i < s.length) {
    final c = s[i];
    // Escapes, and a backslash before a line break.
    if (c == r'\' && i + 1 < s.length) {
      if (s[i + 1] == '\n') {
        flush();
        out.add(const MdBreak());
        i += 2;
        continue;
      }
      if (_punct.contains(s[i + 1])) {
        text.write(s[i + 1]);
        i += 2;
        continue;
      }
    }
    if (c == '\n') {
      // Two spaces before it break the line; otherwise it is a space.
      final str = text.toString();
      if (str.endsWith('  ')) {
        text
          ..clear()
          ..write(str.trimRight());
        flush();
        out.add(const MdBreak());
      } else {
        text
          ..clear()
          ..write('${str.trimRight()} ');
      }
      i++;
      while (i < s.length && s[i] == ' ') {
        i++;
      }
      continue;
    }
    if (c == '`') {
      var n = 0;
      while (i + n < s.length && s[i + n] == '`') {
        n++;
      }
      final tick = '`' * n;
      var close = s.indexOf(tick, i + n);
      while (close >= 0 && close + n < s.length && s[close + n] == '`') {
        close = s.indexOf(tick, close + n + 1);
      }
      if (close >= 0) {
        flush();
        var code = s.substring(i + n, close).replaceAll('\n', ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim().isNotEmpty) code = code.substring(1, code.length - 1);
        out.add(MdCodeSpan(code));
        i = close + n;
        continue;
      }
      text.write(tick);
      i += n;
      continue;
    }
    if (c == '[' || (c == '!' && i + 1 < s.length && s[i + 1] == '[')) {
      final link = _linkAt(s, c == '!' ? i + 1 : i);
      if (link != null) {
        flush();
        final (label, href, end) = link;
        out.add(c == '!' ? MdText(label) : MdLink(href, parseInline(label)));
        i = end;
        continue;
      }
    }
    if (c == '<') {
      final close = s.indexOf('>', i);
      if (close > i) {
        final inner = s.substring(i + 1, close);
        if (RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$').hasMatch(inner)) {
          flush();
          out.add(MdLink(inner, [MdText(inner)]));
          i = close + 1;
          continue;
        }
      }
    }
    if ((c == 'h' || c == 'w') && (i == 0 || !_wordChar.hasMatch(s[i - 1]))) {
      final m = _url.firstMatch(s.substring(i));
      if (m != null && m[0]!.length > (m[0]!.startsWith('www.') ? 4 : 8)) {
        var u = m[0]!;
        // Trailing punctuation, and a closing paren without its opening one, stay outside the link.
        while (u.isNotEmpty) {
          final last = u[u.length - 1];
          if ('?!.,:*_~\'"'.contains(last)) {
            u = u.substring(0, u.length - 1);
          } else if (last == ')' && ')'.allMatches(u).length > '('.allMatches(u).length) {
            u = u.substring(0, u.length - 1);
          } else {
            break;
          }
        }
        flush();
        out.add(MdLink(u.startsWith('www.') ? 'http://$u' : u, [MdText(u)]));
        i += u.length;
        continue;
      }
    }
    if (c == '*' || c == '_' || c == '~') {
      final styled = _emphasisAt(s, i);
      if (styled != null) {
        flush();
        final (node, end) = styled;
        out.add(node);
        i = end;
        continue;
      }
      // A run of delimiters that opens nothing is text.
      var n = 0;
      while (i + n < s.length && s[i + n] == c) {
        n++;
      }
      text.write(s.substring(i, i + n));
      i += n;
      continue;
    }
    text.write(c);
    i++;
  }
  flush();
  return out;
}

(String, String, int)? _linkAt(String s, int i) {
  var depth = 0;
  var j = i;
  for (; j < s.length; j++) {
    if (s[j] == r'\') {
      j++;
      continue;
    }
    if (s[j] == '`') {
      final close = s.indexOf('`', j + 1);
      if (close > 0) j = close;
      continue;
    }
    if (s[j] == '[') depth++;
    if (s[j] == ']' && --depth == 0) break;
  }
  if (j >= s.length || j + 1 >= s.length || s[j + 1] != '(') return null;
  var k = j + 2;
  var parens = 1;
  for (; k < s.length; k++) {
    if (s[k] == r'\') {
      k++;
      continue;
    }
    if (s[k] == '(') parens++;
    if (s[k] == ')' && --parens == 0) break;
  }
  if (k >= s.length) return null;
  var dest = s.substring(j + 2, k).trim();
  final titled = RegExp(r'''^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$''').firstMatch(dest);
  if (titled != null) dest = titled[1]!;
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.substring(1, dest.length - 1);
  if (dest.contains(RegExp(r'\s'))) return null;
  return (s.substring(i + 1, j), dest, k + 1);
}

(MdInline, int)? _emphasisAt(String s, int i) {
  final c = s[i];
  var n = 0;
  while (i + n < s.length && s[i + n] == c) {
    n++;
  }
  // *** opens strong around em: read it as strong and let the inner * pair up.
  final len = n >= 2 ? 2 : 1;
  if (c == '~' && n > 2) return null;
  final open = i + len;
  if (open >= s.length || s[open] == ' ' || s[open] == '\n') return null;
  // Underscores do not open or close inside a word.
  if (c == '_' && i > 0 && _wordChar.hasMatch(s[i - 1])) return null;
  final delim = c * len;
  var k = open + 1;
  while (true) {
    k = s.indexOf(delim, k);
    if (k < 0) return null;
    // A closing run longer than the delimiter closes with its last characters (***x*** is strong around em).
    if (len == 2) {
      while (k + len < s.length && s[k + len] == c) {
        k++;
      }
    }
    final before = s[k - 1];
    final after = k + len < s.length ? s[k + len] : '';
    // Not a closer: escaped, after a space, inside a code span, a single one that is part of a pair, or an
    // underscore with a word right after it.
    final escaped = before == r'\';
    final runOn = len == 1 && (after == c || before == c);
    final wordAfter = c == '_' && after.isNotEmpty && _wordChar.hasMatch(after);
    if (!escaped && before != ' ' && before != '\n' && !runOn && !wordAfter && !_insideCode(s, open, k)) break;
    k += len == 1 && after == c ? 2 : 1;
  }
  final kind = c == '~' ? 'del' : (len == 2 ? 'strong' : 'em');
  return (MdStyled(kind, parseInline(s.substring(open, k))), k + len);
}

bool _insideCode(String s, int from, int at) => '`'.allMatches(s.substring(from, at)).length.isOdd;
