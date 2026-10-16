import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/voice/captions.dart';

List<String> chunked(String id, Map<String, Object?> message, int parts) {
  final encoded = base64.encode(utf8.encode(jsonEncode(message)));
  final size = (encoded.length / parts).ceil();
  return [for (var i = 0; i < parts; i++) '$id|${i + 1}|$parts|${encoded.substring(i * size, ((i + 1) * size).clamp(0, encoded.length))}'];
}

void main() {
  test('chunks arrive out of order; the turn is captioned once all are in', () {
    final c = LiveCaptions();
    final [first, second] = chunked('m1', {'object': 'user.transcription', 'turn_id': 3, 'text': '我想看看项目', 'final': false}, 2);
    expect(c.feed(second), isFalse);
    expect(c.turns, isEmpty);
    expect(c.feed(first), isTrue);
    expect(c.turns.single.text, '我想看看项目');
    expect(c.turns.single.speaker, Speaker.you);
    expect(c.turns.single.done, isFalse);
  });

  test("a turn's text is replaced as it grows, and ends with final or turn_status", () {
    final c = LiveCaptions();
    c.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '你好', 'final': false});
    c.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '你好，农场怎么样', 'final': true});
    c.apply({'object': 'assistant.transcription', 'turn_id': 1, 'text': '挺好', 'turn_status': 0});
    c.apply({'object': 'assistant.transcription', 'turn_id': 1, 'text': '挺好的，地里有一个帮工。', 'turn_status': 1});
    expect(c.turns.map((t) => (t.speaker, t.text, t.done)), [(Speaker.you, '你好，农场怎么样', true), (Speaker.manager, '挺好的，地里有一个帮工。', true)]);
  });

  test("talking over the manager stops its turn where it was; later text of that turn is ignored", () {
    final c = LiveCaptions();
    c.apply({'object': 'assistant.transcription', 'turn_id': 2, 'text': '今天地里', 'turn_status': 0});
    c.apply({'object': 'message.interrupt', 'turn_id': 2});
    c.apply({'object': 'assistant.transcription', 'turn_id': 2, 'text': '今天地里有三块熟了', 'turn_status': 2});
    expect(c.turns.single.text, '今天地里');
    expect(c.turns.single.interrupted, isTrue);
  });

  test("the agent's state is what it last said", () {
    final c = LiveCaptions();
    expect(c.agentState, isNull);
    c.apply({'object': 'message.state', 'state': 'thinking', 'turn_id': 1});
    c.apply({'object': 'message.state', 'state': 'speaking', 'turn_id': 1});
    expect(c.agentState, 'speaking');
  });

  test('only the last few turns are kept', () {
    final c = LiveCaptions();
    for (var i = 0; i < LiveCaptions.keep + 3; i++) {
      c.apply({'object': 'user.transcription', 'turn_id': i, 'text': '第 $i 句', 'final': true});
    }
    expect(c.turns.length, LiveCaptions.keep);
    expect(c.turns.first.text, '第 3 句');
  });
}
