import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final base = Uri.parse('http://127.0.0.1:8787');

  test('a command sends its body to its path and method; 204 is done', () async {
    late http.Request seen;
    final api = VibeValleyApi(
      base,
      MockClient((r) async {
        seen = r;
        return http.Response('', 204);
      }),
    );
    await api.farm.say(body: const SayRequest(text: '种一垄萝卜', conversation: 3));
    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/say');
    expect(jsonDecode(seen.body), {'text': '种一垄萝卜', 'conversation': 3});
  });

  test('path and query parameters; a chat page comes back as the same ChatMessage the state uses', () async {
    late Uri seen;
    final api = VibeValleyApi(
      base,
      MockClient((r) async {
        seen = r.url;
        return http.Response(
          jsonEncode([
            {'seq': 7, 'conversation': 1, 'from': 'foreman', 'fromKind': 'foreman', 'name': '管家', 'kind': 'chat', 'text': '好', 'final': true, 'at': 1},
          ]),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    final page = await api.farm.chatHistory(id: '1', before: '10', limit: '20');
    expect(seen.path, '/api/chat/1/messages');
    expect(seen.queryParameters, {'before': '10', 'limit': '20'});
    expect(page.single, isA<ChatMessage>());
    expect(page.single.text, '好');
  });

  test("a tagged refusal is a VibeValleyApiError with the server's reason", () async {
    final api = VibeValleyApi(
      base,
      MockClient(
        (_) async => http.Response(jsonEncode({'_tag': 'FarmRefused', 'reason': '这块地有人了'}), 409, headers: {'content-type': 'application/json; charset=utf-8'}),
      ),
    );
    await expectLater(
      api.farm.say(body: const SayRequest(text: 'x')),
      throwsA(
        isA<VibeValleyApiError>().having((e) => e.tag, 'tag', 'FarmRefused').having((e) => e.reason, 'reason', '这块地有人了').having((e) => e.status, 'status', 409),
      ),
    );
  });

  test('a tagged union in a body is written with its tag (voice vendors)', () {
    final start = const StartRequest(channel: 'c', uid: '7', captions: VoiceCaptions.datastream).toJson();
    expect(start, {'channel': 'c', 'uid': '7', 'captions': 'datastream'});
  });
}
