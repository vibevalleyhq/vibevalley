import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/shared/swatches.dart';
import 'package:vibevalley/workbench/docs/doc_editor.dart';
import 'package:vibevalley/workbench/docs/doc_editor_model.dart';
import 'package:vibevalley/workbench/docs/docs_page.dart';

import '../support/workbench.dart';

Block block(String id, String key, String text, {String type = blockParagraph, BlockAttrs attrs = const BlockAttrs(), String by = docOwner}) => Block(
  id: id,
  docId: 'd1',
  orderKey: key,
  type: type,
  attrs: attrs,
  text: [if (text.isNotEmpty) DocSpan(t: text, marks: const DocMarks())],
  rev: 1,
  updatedBy: by,
  updated: 1,
);

/// A server with one document: it answers each op applied, and keeps each batch sent.
class DocBackend {
  DocBackend(this.blocks);
  final List<Block> blocks;
  final submits = <Map<String, dynamic>>[];
  double seq = 1;
  int gets = 0;
  int demos = 0;
  final agents = WorkbenchBackend(agents: [agent('backend', '后端老周')]);

  List<Map<String, dynamic>> get ops => [for (final s in submits) ...(s['ops'] as List).cast<Map<String, dynamic>>()];

  Future<http.Response> handle(http.Request r) async {
    final path = r.url.path;
    if (r.method == 'GET' && path == '/api/v1/docs') {
      return jsonResponse([const Document(id: 'd1', title: '周报', seq: 1, created: 1, updated: 1).toJson()]);
    }
    if (r.method == 'GET' && path == '/api/v1/docs/d1') {
      gets++;
      return jsonResponse(
        DocSnapshot(
          doc: Document(id: 'd1', title: '周报', seq: seq, created: 1, updated: 1),
          blocks: blocks,
        ).toJson(),
      );
    }
    if (r.method == 'POST' && path == '/api/v1/docs/d1/demo') {
      demos++;
      return http.Response('', 204);
    }
    if (r.method == 'POST' && path == '/api/v1/docs/d1/submit') {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      submits.add(body);
      final results = [
        for (final op in (body['ops'] as List).cast<Map<String, dynamic>>())
          DocOpResult(status: DocOpStatus.applied, blockId: (op['blockId'] ?? op['targetId'] ?? (op['block'] as Map?)?['id']) as String, rev: 2),
      ];
      return jsonResponse(DocAck(batchId: body['batchId'] as String, seq: 1.0 + submits.length, results: results, blocks: const []).toJson());
    }
    return agents.handle(r);
  }
}

Finder field(String id) => find.descendant(of: labelled('块 $id'), matching: find.byType(EditableText));

Future<void> open(WidgetTester t, DocBackend server) => pumpPage(t, const DocsPage(id: 'd1'), server.handle);

Future<void> focusAt(WidgetTester t, String id, String text, int at) async {
  await t.tap(field(id));
  await t.pump();
  t.testTextInput.updateEditingValue(
    TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: at),
    ),
  );
  await t.pump();
}

void main() {
  testWidgets('Enter in the middle of a block splits it, as one split_block with the offset in code points', (t) async {
    final server = DocBackend([block('a', 'V', '你好👍世界')]);
    await open(t, server);
    await focusAt(t, 'a', '你好👍世界', 4);
    // The field's line break is Enter.
    t.testTextInput.updateEditingValue(const TextEditingValue(text: '你好👍\n世界', selection: TextSelection.collapsed(offset: 5)));
    await settle(t);
    final fields = [
      for (final e in t.widgetList<EditableText>(find.descendant(of: find.byType(DocBlocks), matching: find.byType(EditableText)))) e.controller.text,
    ];
    expect(fields, ['你好👍', '世界']);
    final split = server.ops.single;
    expect(split['op'], 'split_block');
    expect(split['blockId'], 'a');
    expect(split['offset'], 3);
    expect(split['baseRev'], 1);
    expect((split['newBlock'] as Map)['type'], blockParagraph);
  });

  testWidgets('pasted lines become blocks', (t) async {
    final server = DocBackend([block('a', 'V', '')]);
    await open(t, server);
    await focusAt(t, 'a', '', 0);
    t.testTextInput.updateEditingValue(const TextEditingValue(text: '一\n二\n三', selection: TextSelection.collapsed(offset: 5)));
    await settle(t);
    final fields = [
      for (final e in t.widgetList<EditableText>(find.descendant(of: find.byType(DocBlocks), matching: find.byType(EditableText)))) e.controller.text,
    ];
    expect(fields, ['一', '二', '三']);
    expect([for (final op in server.ops) op['op']], ['update_text', 'split_block', 'update_text', 'split_block']);
  });

  testWidgets('Backspace at the start of a block joins it to the one before', (t) async {
    final server = DocBackend([block('a', 'V', '前'), block('b', 'W', '后')]);
    await open(t, server);
    await focusAt(t, 'b', '后', 0);
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await settle(t);
    final fields = [
      for (final e in t.widgetList<EditableText>(find.descendant(of: find.byType(DocBlocks), matching: find.byType(EditableText)))) e.controller.text,
    ];
    expect(fields, ['前后']);
    expect(server.ops.single, {'op': 'merge_blocks', 'targetId': 'a', 'sourceId': 'b'});
  });

  testWidgets('Markdown at the start of a paragraph changes its type', (t) async {
    for (final (typed, type, attrs) in [
      ('# ', blockHeading, {'level': 1}),
      ('## ', blockHeading, {'level': 2}),
      ('- ', blockBulleted, <String, dynamic>{}),
      ('1. ', blockNumbered, <String, dynamic>{}),
      ('[] ', blockTodo, {'checked': false}),
      ('> ', blockQuote, <String, dynamic>{}),
      ('```', blockCode, <String, dynamic>{}),
    ]) {
      final server = DocBackend([block('a', 'V', '')]);
      await t.pumpWidget(const SizedBox());
      await open(t, server);
      await t.enterText(field('a'), typed);
      await settle(t);
      expect(server.ops.single, {'op': 'set_type', 'blockId': 'a', 'type': type, 'attrs': attrs}, reason: typed);
      expect(t.widget<EditableText>(field('a')).controller.text, '', reason: typed);
    }
  });

  testWidgets('typing is sent once it stops: one update_text with the last text', (t) async {
    final server = DocBackend([block('a', 'V', '')]);
    await open(t, server);
    for (final text in ['今', '今天', '今天天气']) {
      await t.enterText(field('a'), text);
      await t.pump(const Duration(milliseconds: 100));
    }
    expect(server.submits, isEmpty);
    await t.pump(const Duration(milliseconds: 600));
    await settle(t);
    expect(server.submits, hasLength(1));
    expect(server.ops.single, {
      'op': 'update_text',
      'blockId': 'a',
      'baseRev': 1,
      'text': [
        {'t': '今天天气', 'marks': <String, dynamic>{}},
      ],
    });
  });

  testWidgets('a word being composed is not sent, and goes once it is committed', (t) async {
    final server = DocBackend([block('a', 'V', '')]);
    await open(t, server);
    await focusAt(t, 'a', '', 0);
    t.testTextInput.updateEditingValue(
      const TextEditingValue(text: 'ni', selection: TextSelection.collapsed(offset: 2), composing: TextRange(start: 0, end: 2)),
    );
    await t.pump(const Duration(milliseconds: 700));
    await settle(t);
    expect(server.submits, isEmpty);
    t.testTextInput.updateEditingValue(const TextEditingValue(text: '你', selection: TextSelection.collapsed(offset: 1)));
    await t.pump(const Duration(milliseconds: 600));
    await settle(t);
    expect((server.ops.single['text'] as List).single['t'], '你');
  });

  testWidgets("each block's bar is coloured by who wrote it last: the owner, or the helper's look", (t) async {
    final server = DocBackend([block('a', 'V', '主人写的'), block('b', 'W', '帮工写的', by: 'backend'), block('c', 'X', '走了的帮工写的', by: 'gone')]);
    await open(t, server);
    Color bar(String id) => (t.widget<Container>(find.byKey(ValueKey('author-$id'))).decoration! as BoxDecoration).color!;
    expect(bar('a'), ownerColor);
    expect(bar('b'), hexColor(look().trim));
    expect(bar('c'), authorColor('gone', null));
    expect(bar('c'), isNot(ownerColor));
  });

  testWidgets('marks are drawn as they are', (t) async {
    final server = DocBackend([
      Block(
        id: 'a',
        docId: 'd1',
        orderKey: 'V',
        type: blockParagraph,
        attrs: const BlockAttrs(),
        text: const [
          DocSpan(t: '这周把', marks: DocMarks()),
          DocSpan(t: '块编辑器', marks: DocMarks(bold: true)),
        ],
        rev: 1,
        updatedBy: docOwner,
        updated: 1,
      ),
    ]);
    await open(t, server);
    final editable = t.state<EditableTextState>(field('a'));
    final span = editable.buildTextSpan();
    final bold = span.children!.cast<TextSpan>().firstWhere((s) => s.text == '块编辑器');
    expect(bold.style?.fontWeight, FontWeight.w600);
  });

  testWidgets('a block of a type this client does not know is a read-only placeholder', (t) async {
    final server = DocBackend([block('a', 'V', '一段'), block('t', 'W', '', type: 'table')]);
    await open(t, server);
    expect(find.textContaining('「table」'), findsOneWidget);
    expect(field('t'), findsNothing);
  });

  testWidgets('lists are numbered as they are drawn, and a todo ticks', (t) async {
    final server = DocBackend([
      block('a', 'V', '第一', type: blockNumbered),
      block('b', 'W', '第二', type: blockNumbered),
      block('c', 'X', '买菜', type: blockTodo, attrs: const BlockAttrs(checked: false)),
    ]);
    await open(t, server);
    expect(find.text('1.'), findsOneWidget);
    expect(find.text('2.'), findsOneWidget);
    await t.tap(find.bySemanticsLabel('没做完'));
    await settle(t);
    expect(server.ops.single, {
      'op': 'set_attrs',
      'blockId': 'c',
      'attrs': {'checked': true},
    });
  });

  testWidgets('Enter on an empty list item leaves the list', (t) async {
    final server = DocBackend([block('a', 'V', '', type: blockBulleted)]);
    await open(t, server);
    await focusAt(t, 'a', '', 0);
    t.testTextInput.updateEditingValue(const TextEditingValue(text: '\n', selection: TextSelection.collapsed(offset: 1)));
    await settle(t);
    expect(server.ops.single, {'op': 'set_type', 'blockId': 'a', 'type': blockParagraph, 'attrs': <String, dynamic>{}});
  });

  testWidgets('the demo button asks the server to start the demo', (t) async {
    final server = DocBackend([block('a', 'V', '一段')]);
    await open(t, server);
    await t.tap(find.text('演示：几个帮工一起写'));
    await settle(t);
    expect(server.demos, 1);
    // Just started: asks come every second.
    final before = server.gets;
    await t.pump(pollFast);
    await settle(t);
    expect(server.gets, before + 1);
  });

  testWidgets("another writer's change makes the page ask every second and its block breathe; quiet, every four", (t) async {
    final server = DocBackend([block('a', 'V', '主人写的')]);
    await open(t, server);
    // Each tick is a second and a bit (settle pumps too).
    Future<int> asks(int seconds) async {
      final from = server.gets;
      for (var i = 0; i < seconds; i++) {
        await t.pump(pollFast);
        await settle(t);
      }
      return server.gets - from;
    }

    expect(await asks(3), 0, reason: 'quiet: the first ask is four seconds in');
    server.blocks.add(block('h', 'W', '老周写的', by: 'backend'));
    server.seq = 2;
    expect(await asks(1), 1);
    expect(find.byKey(const ValueKey('writing-h')), findsOneWidget);
    expect(find.byKey(const ValueKey('writing-a')), findsNothing);
    expect(find.textContaining('帮工在写'), findsOneWidget);

    expect(await asks(3), 3, reason: 'another writer was heard: an ask every second');
    await asks(busyPolls);
    expect(find.byKey(const ValueKey('writing-h')), findsNothing);
    expect(find.textContaining('帮工在写'), findsNothing);
    expect(await asks(3), lessThanOrEqualTo(1), reason: 'quiet again: an ask every four seconds');
  });

  testWidgets("the block the owner is in keeps its text while a helper's change waits; it comes in once they leave", (t) async {
    final server = DocBackend([block('h', 'V', '老周写', by: 'backend')]);
    await open(t, server);
    await t.tap(field('h'));
    await t.pump();
    server.blocks[0] = Block(
      id: 'h',
      docId: 'd1',
      orderKey: 'V',
      type: blockParagraph,
      attrs: const BlockAttrs(),
      text: const [DocSpan(t: '老周写了一段', marks: DocMarks())],
      rev: 2,
      updatedBy: 'backend',
      updated: 2,
    );
    server.seq = 2;
    await t.pump(pollEvery);
    await settle(t);
    expect(t.widget<EditableText>(field('h')).controller.text, '老周写');
    FocusManager.instance.primaryFocus?.unfocus();
    await t.pump(pollEvery);
    await settle(t);
    expect(t.widget<EditableText>(field('h')).controller.text, '老周写了一段');
  });
}
