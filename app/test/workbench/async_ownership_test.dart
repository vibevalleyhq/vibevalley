import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/chat/chat_state.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/messages.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/workbench/chat/chat_composer.dart';
import 'package:vibevalley/workbench/connectors/connectors_page.dart';
import 'package:vibevalley/workbench/shared/resource.dart';

import '../support/server.dart';

const live = CoreState(call: CallState.live, manager: ManagerState.listening, sessions: []);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a mutation result wins over an older resource read and its error', () async {
    for (final fails in [false, true]) {
      final pending = Completer<int>();
      final resource = WorkbenchResource(() => pending.future);
      final read = resource.refresh();
      resource.put(2);
      if (fails) {
        pending.completeError(StateError('stale'));
      } else {
        pending.complete(1);
      }
      await read;
      expect(resource.value, 2);
      expect(resource.error, isNull);
      resource.dispose();
    }
  });

  test('a connector poll cannot undo logout or overlap another poll', () async {
    final pending = Completer<http.Response>();
    const connected = ConnectorStatus(id: ConnectorId.weixin, state: ConnectorState.connected, pending: 0);
    const off = ConnectorStatus(id: ConnectorId.weixin, state: ConnectorState.off, pending: 0);
    final server = FakeServer((r) async => r.method == 'GET' ? pending.future : jsonResponse(off.toJson()));
    final c = ProviderContainer(overrides: [apiProvider.overrideWithValue(server.api)]);
    addTearDown(c.dispose);
    addTearDown(server.close);
    final actions = c.read(connectorsProvider.notifier);
    final poll = actions.refresh();
    await actions.refresh();
    await actions.logout(ConnectorId.weixin);
    pending.complete(jsonResponse([connected.toJson()]));
    await poll;
    expect(c.read(connectorsProvider)![ConnectorId.weixin]!.state, ConnectorState.off);
    expect(server.requests.where((r) => r.method == 'GET'), hasLength(1));
  });

  test('chat shares an in-flight history read and discards it after disposal', () async {
    final pending = Completer<http.Response>();
    final entered = Completer<void>();
    final server = FakeServer((_) {
      entered.complete();
      return pending.future;
    });
    final c = ProviderContainer(overrides: [apiProvider.overrideWithValue(server.api)]);
    addTearDown(server.close);
    final actions = c.read(chatActionsProvider);
    final first = actions.showChat('c1');
    final second = actions.showChat('c1');
    await entered.future;
    expect(server.requests, hasLength(1));
    c.dispose();
    pending.complete(jsonResponse([]));
    await Future.wait([first, second]);
  });

  test('opening the manager shares one request and preserves the server error', () async {
    final pending = Completer<http.Response>();
    final server = FakeServer((_) => pending.future);
    final c = ProviderContainer(overrides: [apiProvider.overrideWithValue(server.api), stateProvider.overrideWithValue(null)]);
    addTearDown(c.dispose);
    addTearDown(server.close);
    final first = expectLater(c.read(messagesProvider).send('first', sendKey: 'k1'), throwsA(isA<VibeValleyApiError>()));
    final second = expectLater(c.read(messagesProvider).send('second', sendKey: 'k2'), throwsA(isA<VibeValleyApiError>()));
    pending.complete(jsonResponse({'reason': '没有钥匙'}, 503));
    await Future.wait([first, second]);
    expect(server.requests, hasLength(1));
  });

  Future<void> composer(WidgetTester t, FakeServer server) => t.pumpWidget(
    ProviderScope(
      overrides: [apiProvider.overrideWithValue(server.api), stateProvider.overrideWithValue(live), atlasProvider.overrideWith((_) async => atlas)],
      child: MaterialApp(
        theme: farmTheme(),
        home: const Scaffold(body: ChatComposer(conversation: null, placeholder: '说句话')),
      ),
    ),
  );

  testWidgets('a failed send retains the draft and blocks duplicate submissions', (t) async {
    final pending = Completer<http.Response>();
    final server = FakeServer((_) => pending.future);
    addTearDown(server.close);
    await composer(t, server);
    await t.enterText(find.byType(TextField), '保留这句话');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(server.requests, hasLength(1));
    pending.complete(jsonResponse({'reason': '暂时连不上'}, 503));
    await t.pumpAndSettle();
    expect(find.text('保留这句话'), findsOneWidget);
    expect(find.text('暂时连不上'), findsOneWidget);
  });

  testWidgets('a successful send does not clear text typed while it was pending', (t) async {
    final pending = Completer<http.Response>();
    final server = FakeServer((_) => pending.future);
    addTearDown(server.close);
    await composer(t, server);
    await t.enterText(find.byType(TextField), '第一句');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    await t.enterText(find.byType(TextField), '第二句');
    pending.complete(http.Response('', 204));
    await t.pumpAndSettle();
    expect(find.text('第二句'), findsOneWidget);
  });
}
