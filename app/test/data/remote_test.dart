import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/remote.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/workbench.dart';

void main() {
  final profiles = [agent('helper', '帮工'), agent(managerAgent, '管家')];
  final baseRuntime = runtime('claude');

  ProviderContainer container(FakeServer server) {
    final container = ProviderContainer(overrides: [serverProvider.overrideWithValue(server)]);
    addTearDown(container.dispose);
    addTearDown(server.close);
    return container;
  }

  Future<void> initial(ProviderContainer c) async {
    final done = Completer<void>();
    final subscription = c.listen(workbenchConfigProvider, (_, value) {
      if ((value.loaded || value.error != null) && !done.isCompleted) done.complete();
    }, fireImmediately: true);
    await done.future.timeout(const Duration(seconds: 3));
    subscription.close();
  }

  http.Response answer(http.Request request) => switch (request.url.path) {
    '/api/v1/agents' => jsonResponse(profiles.map((a) => a.toJson()).toList()),
    '/api/v1/skills' => jsonResponse([]),
    '/api/v1/runtimes' => jsonResponse([baseRuntime.toJson()]),
    _ => http.Response('', 204),
  };

  test('deleting a skill keeps the manager apart from dispatchable profiles', () async {
    final c = container(FakeServer((r) async => answer(r)));
    await initial(c);
    await c.read(workbenchConfigProvider.notifier).deleteSkill('old');
    final config = c.read(workbenchConfigProvider);
    expect(config.agents.map((a) => a.id), ['helper']);
    expect(config.manager?.id, managerAgent);
  });

  test('a runtime push wins over an older in-flight snapshot', () async {
    Completer<http.Response>? pending;
    final entered = Completer<void>();
    final server = FakeServer((r) async {
      if (r.url.path == '/api/v1/runtimes' && pending != null) {
        entered.complete();
        return pending.future;
      }
      return answer(r);
    });
    final c = container(server);
    await initial(c);
    pending = Completer<http.Response>();
    final refresh = c.read(workbenchConfigProvider.notifier).refresh();
    await entered.future;
    final pushed = runtime('claude', available: false);
    final observed = Completer<void>();
    final sub = c.listen(workbenchConfigProvider, (_, next) {
      if (next.runtime('claude')?.installation is InstallationNotFound && !observed.isCompleted) observed.complete();
    });
    server.sideFeed.add(LiveEventRuntime(at: 1, info: pushed));
    await observed.future.timeout(const Duration(seconds: 3));
    pending.complete(jsonResponse([baseRuntime.toJson()]));
    await refresh;
    expect(c.read(workbenchConfigProvider).runtime('claude')?.installation, isA<InstallationNotFound>());
    sub.close();
  });

  test('a newer refresh wins when profile responses finish out of order', () async {
    Completer<http.Response>? pending;
    final entered = Completer<void>();
    final server = FakeServer((r) async {
      if (r.url.path == '/api/v1/agents' && pending != null) {
        final response = pending!;
        pending = null;
        entered.complete();
        return response.future;
      }
      return answer(r);
    });
    final c = container(server);
    await initial(c);
    final old = pending = Completer<http.Response>();
    final slow = c.read(workbenchConfigProvider.notifier).refresh();
    await entered.future;
    await c.read(workbenchConfigProvider.notifier).refresh();
    old.complete(jsonResponse([agent('stale', '旧帮工').toJson()]));
    await slow;
    expect(c.read(workbenchConfigProvider).agents.map((a) => a.id), ['helper']);
  });

  test('failed initial loading is an error, and refresh can recover', () async {
    var fail = true;
    final c = container(FakeServer((r) async => fail && r.url.path == '/api/v1/agents' ? http.Response('offline', 503) : answer(r)));
    await initial(c);
    expect(c.read(workbenchConfigProvider).loaded, isFalse);
    expect(c.read(workbenchConfigProvider).error, isNotNull);
    expect(c.read(agentsProvider).hasError, isTrue);
    fail = false;
    await c.read(workbenchConfigProvider.notifier).refresh();
    expect(c.read(workbenchConfigProvider).loaded, isTrue);
    expect(c.read(workbenchConfigProvider).error, isNull);
    expect(c.read(agentsProvider).requireValue.keys, ['helper']);
  });
}
