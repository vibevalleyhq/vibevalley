import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/doc_blocks.dart';

DocSpan span(String t, {bool bold = false}) => DocSpan(
  t: t,
  marks: DocMarks(bold: bold ? true : null),
);

void main() {
  test('keys between, as internal/doc/order.go makes them', () {
    // The same pairs order_test.go checks, with the keys the Go gives.
    expect(keyBetween('', ''), 'V');
    expect(keyBetween('V', ''), 'W');
    expect(keyBetween('', 'V'), 'U');
    expect(keyBetween('z', ''), 'z1');
    expect(keyBetween('', '1'), '0z');
    expect(keyBetween('V', 'W'), 'VV');
    expect(keyBetween('0V', '1'), '0l');
    expect(() => keyBetween('b', 'a'), throwsArgumentError);
    expect(() => keyBetween('a0', ''), throwsArgumentError);
    var keys = <String>[];
    for (var i = 0; i < 300; i++) {
      keys = [...keys, keyBetween(keys.lastOrNull ?? '', '')];
      keys = [keyBetween('', keys.first), ...keys];
      keys = [keys.first, keyBetween(keys[0], keys[1]), ...keys.skip(1)];
    }
    expect([...keys]..sort(), keys);
    expect(keys.every(validKey), isTrue);
  });

  test('offsets are code points', () {
    expect(codePointOffset('你好👍世界', 4), 3);
    expect(codePointOffset('ét', 2), 2);
  });

  test('an edit keeps the marks around it, and typed text takes the marks before it', () {
    final old = [span('你'), span('好', bold: true), span('世界')];
    final edited = editSpans(old, '你好呀世界');
    expect(plainOf(edited), '你好呀世界');
    expect([for (final s in edited) (s.t, s.marks.bold ?? false)], [('你', false), ('好呀', true), ('世界', false)]);
    // An emoji typed next to another is never cut in half.
    final emoji = editSpans([span('👍')], '👍👎');
    expect(plainOf(emoji), '👍👎');
  });

  test('line-start Markdown and list numbers', () {
    expect(markdownShortcut('### 标题')?.type, blockHeading);
    expect(markdownShortcut('[x] 做完了')?.attrs.checked, isTrue);
    expect(markdownShortcut('#没有空格'), isNull);
    expect(
      listNumbers([
        (id: 'a', parentId: null, type: blockNumbered),
        (id: 'a1', parentId: 'a', type: blockNumbered),
        (id: 'b', parentId: null, type: blockNumbered),
        (id: 'p', parentId: null, type: blockParagraph),
        (id: 'c', parentId: null, type: blockNumbered),
      ]),
      {'a': 1, 'a1': 1, 'b': 2, 'c': 1},
    );
  });
}
