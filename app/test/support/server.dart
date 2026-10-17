import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/sprites/atlas.dart';

typedef Call = ({String method, String path, Object? body});
typedef Handle = Future<http.Response> Function(http.Request request);

final atlas = SpriteAtlas.parse(File('assets/pixel/sprites.json').readAsStringSync());

http.Response jsonResponse(Object? body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// Answers by 'METHOD /path': a function is asked with the call, an http.Response goes as it is, anything else as JSON. A path not there is 204.
class Routes {
  Routes([Map<String, Object?> answers = const {}]) : answers = {...answers};

  final Map<String, Object?> answers;
  final calls = <Call>[];

  Iterable<String> get paths => calls.map((c) => '${c.method} ${c.path}');

  List<Call> named(String method, String path) => [
    for (final c in calls)
      if (c.method == method && c.path == path) c,
  ];

  Future<http.Response> handle(http.Request r) async {
    final call = (method: r.method, path: r.url.path, body: r.body.isEmpty ? null : jsonDecode(r.body));
    calls.add(call);
    final key = '${r.method} ${r.url.path}';
    if (!answers.containsKey(key)) return http.Response('', 204);
    var answer = answers[key];
    if (answer is Object? Function(Call)) answer = answer(call);
    return answer is http.Response ? answer : jsonResponse(answer);
  }
}

/// The one stand-in for the server: every request goes to handle and is kept; the tests feed the frames and side events.
class FakeServer extends VibeValleyServer {
  FakeServer([Handle? handle]) : _handle = handle ?? Routes().handle, super(Uri.parse('http://farm.test'));

  final Handle _handle;
  final requests = <http.Request>[];
  final frameFeed = StreamController<ReceivedFrame>.broadcast();
  final sideFeed = StreamController<LiveEvent>.broadcast();

  late final VibeValleyApi _api = VibeValleyApi(
    base,
    MockClient((r) {
      requests.add(r);
      return _handle(r);
    }),
  );

  @override
  VibeValleyApi get api => _api;

  @override
  Stream<ReceivedFrame> get frames => frameFeed.stream;

  @override
  Stream<LiveEvent> get sideEvents => sideFeed.stream;

  @override
  Future<bool> healthy() async => true;

  Iterable<http.Request> to(String method, String path) => requests.where((r) => r.method == method && r.url.path == path);
}

/// No pumpAndSettle: some pages poll on a timer and some animations loop. A few real turns for the fake server's answers, a few frames for the page.
Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await t.pump(const Duration(milliseconds: 20));
  }
}
