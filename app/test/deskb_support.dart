// What deskB's widget tests share: a fake server whose VibeValleyApi answers from a MockClient, and a host that puts a desk
// page on a wide screen with the providers it reads overridden (no network, no SSE).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/sprites/atlas.dart';
import 'package:vibevalley/ui/kit/kit.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// A request the fake server got: its method, path and JSON body.
typedef Call = ({String method, String path, Object? body});

/// Answers by method and path ('GET /api/runtimes'); anything else is a 404.
class FakeBackend {
  FakeBackend(this.routes);
  final Map<String, Object? Function(Call call)> routes;
  final calls = <Call>[];

  http.Client get client => MockClient((r) async {
    final call = (method: r.method, path: r.url.path, body: r.body.isEmpty ? null : jsonDecode(r.body));
    calls.add(call);
    final route = routes['${r.method} ${r.url.path}'];
    if (route == null) return http.Response(jsonEncode({'_tag': 'FarmMissing', 'reason': '没有 ${r.url.path}'}), 404);
    final answer = route(call);
    if (answer is http.Response) return answer;
    return http.Response.bytes(utf8.encode(jsonEncode(answer)), 200, headers: {'content-type': 'application/json'});
  });

  List<Call> named(String method, String path) => [
    for (final c in calls)
      if (c.method == method && c.path == path) c,
  ];
}

class FakeServer implements VibeValleyServer {
  FakeServer(FakeBackend backend) : api = VibeValleyApi(Uri.parse('http://127.0.0.1:8787'), backend.client);

  @override
  final VibeValleyApi api;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final atlas = SpriteAtlas.parse(File('assets/pixel/sprites.json').readAsStringSync());

/// Hosts `page` 1400 × 1000 with the server faked, the side events from `events` and the farm state `farm`.
Future<ProviderContainer> pumpPage(WidgetTester t, Widget page, FakeBackend backend, {Stream<SiteEvent>? events, FarmState? farm}) async {
  t.view.physicalSize = const Size(1400, 1000);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  final container = ProviderContainer(
    overrides: [
      serverProvider.overrideWithValue(FakeServer(backend)),
      sideEventsProvider.overrideWith((ref) => events ?? const Stream<SiteEvent>.empty()),
      atlasProvider.overrideWith((ref) async => atlas),
      farmProvider.overrideWithValue(farm),
    ],
  );
  addTearDown(container.dispose);
  await t.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: farmTheme(),
        home: Scaffold(body: page),
      ),
    ),
  );
  await settle(t);
  return container;
}

/// Lets the fake answers and the frames after them through (no pumpAndSettle: some pages poll on a timer).
Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await t.pump();
  }
}

Map<String, dynamic> runtimeJson(
  String id, {
  bool available = true,
  bool enabled = true,
  Map<String, dynamic>? usage,
  Map<String, dynamic>? update,
  List<Map<String, dynamic>>? models,
  double? spentToday,
  double? dailyBudget,
}) => {
  'id': id,
  'installation': available ? {'status': 'available', 'via': 'executable', 'command': '/usr/local/bin/$id', 'version': '1.2.3'} : {'status': 'not_found'},
  'models': ?models,
  'usage': ?usage,
  'update': ?update,
  'skills': [
    {'name': 'review', 'description': '看代码'},
  ],
  'settings': {'enabled': enabled, 'binPath': '', 'defaultModel': '', 'defaultEffort': '', 'env': <String, String>{}, 'dailyBudget': ?dailyBudget},
  'spentToday': ?spentToday,
  'checkedAt': DateTime(2026, 10, 14, 9, 5, 7).millisecondsSinceEpoch,
};

Map<String, dynamic> agentJson(String id, String name, String runtime) => {
  'id': id,
  'name': name,
  'role': '',
  'enabled': true,
  'runtime': runtime,
  'model': '',
  'effort': '',
  'persona': '',
  'personaMode': 'append',
  'skills': <String>[],
  'mcpServers': <Object>[],
  'disallowedTools': <String>[],
  'env': <String, String>{},
  'workdir': '',
  'worktree': false,
  'tags': <String>[],
  'look': {'build': 'biped', 'head': 'rounded', 'body': '#fff', 'trim': '#000', 'hat': '#f00', 'eye': '#0ff', 'species': 'fox', 'outfit': 'farmer'},
};
