import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vibevalley/chat/chat_state.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/remote.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/chat.dart';

import '../support/server.dart';

ChatMessage message(String id, double number, String text) => ChatMessage(
  id: id,
  number: number,
  conversation: 'general',
  from: managerAgent,
  fromKind: SenderKind.manager,
  name: '管家',
  kind: MessageKind.chat,
  text: text,
  final_: true,
  at: number,
);

void main() {
  ProviderContainer container(FakeServer server, {CoreState? state}) {
    final c = ProviderContainer(
      overrides: [apiProvider.overrideWithValue(server.api), sideEventsProvider.overrideWith((_) => server.sideEvents), stateProvider.overrideWithValue(state)],
    );
    addTearDown(c.dispose);
    addTearDown(server.close);
    return c;
  }

  test('project creation refreshes every directory reader and returns the exact created project', () async {
    const a = ProjectSummary(
      pullRequest: PullRequestCapability(available: false, reason: "尚未检测 GitHub"),
      name: 'a',
      path: '/a',
      git: true,
      maxSessions: 2,
      last: 1,
    );
    const z = ProjectSummary(
      pullRequest: PullRequestCapability(available: false, reason: "尚未检测 GitHub"),
      name: 'z',
      path: '/z',
      git: true,
      maxSessions: 2,
      last: 2,
    );
    final list = [a];
    final server = FakeServer((r) async {
      if (r.method == 'POST') {
        list.add(z);
        return jsonResponse(z.toJson());
      }
      return jsonResponse(list.map((p) => p.toJson()).toList());
    });
    final c = container(server);
    expect(await c.read(projectNamesProvider.future), ['a']);
    final created = await c.read(projectCatalogProvider.notifier).create(const NewProject(name: 'z'));
    expect(created.name, 'z');
    expect(await c.read(projectNamesProvider.future), ['z', 'a']);
    expect(c.read(projectCatalogProvider).requireValue.map((p) => p.name), ['z', 'a']);
    expect(server.requests.where((r) => r.method == 'GET'), hasLength(2));
  });

  for (final agent in ['helper', managerAgent]) {
    test('$agent memory watches load automatically and mutations return refreshed metadata', () async {
      final note = Memory(id: 'n1', agent: agent, kind: MemoryKind.note, text: '记住', at: 1, recalled: 0);
      final notes = <Memory>[];
      final server = FakeServer((r) async {
        if (r.method == 'POST') {
          notes.add(note);
          return jsonResponse(note.toJson());
        }
        if (r.method == 'DELETE') {
          notes.clear();
          return http.Response('', 204);
        }
        return jsonResponse(MemoryList(memories: notes, sources: const [], file: '/memory', carried: notes.length.toDouble()).toJson());
      });
      final c = container(server);
      expect((await c.read(memoryProvider(agent).future)).memories, isEmpty);
      expect((await c.read(memoryProvider(agent).notifier).write('记住')).ok, isTrue);
      expect(c.read(memoryProvider(agent)).requireValue.carried, 1);
      expect(c.read(memoryProvider(agent)).requireValue.file, '/memory');
      await c.read(memoryProvider(agent).notifier).forget('n1');
      expect(c.read(memoryProvider(agent)).requireValue.memories, isEmpty);
    });
  }

  test('closed memory and project views read external updates when opened again', () async {
    var reads = 0;
    final server = FakeServer((r) async {
      reads++;
      if (r.url.path.startsWith('/api/v1/memories')) return jsonResponse(MemoryList(memories: const [], sources: const [], carried: reads.toDouble()).toJson());
      return jsonResponse([
        ProjectSummary(
          pullRequest: PullRequestCapability(available: false, reason: "尚未检测 GitHub"),
          name: 'project-$reads',
          path: '/p',
          git: true,
          maxSessions: 1,
        ).toJson(),
      ]);
    });
    final c = container(server);
    final first = c.listen(memoryProvider('helper'), (_, _) {});
    expect((await c.read(memoryProvider('helper').future)).carried, 1);
    first.close();
    await c.pump();
    final again = c.listen(memoryProvider('helper'), (_, _) {});
    expect((await c.read(memoryProvider('helper').future)).carried, 2);
    again.close();
    final names = c.listen(projectNamesProvider, (_, _) {});
    expect(await c.read(projectNamesProvider.future), ['project-3']);
    names.close();
    await c.pump();
    final later = c.listen(projectNamesProvider, (_, _) {});
    expect(await c.read(projectNamesProvider.future), ['project-4']);
    later.close();
  });

  test('watching a trajectory owns its initial history and merges live events received during the read', () async {
    final pending = Completer<http.Response>();
    final entered = Completer<void>();
    final server = FakeServer((r) {
      entered.complete();
      return pending.future;
    });
    final c = container(server);
    final first = c.listen(sessionEventsProvider('s1'), (_, _) {});
    final second = c.listen(sessionEventsProvider('s1'), (_, _) {});
    await entered.future;
    const recent = SessionEvent(seq: 2, time: 2, type: SessionEventType.assistantMessage, text: 'new');
    server.sideFeed.add(const LiveEventSession(id: 's1', activity: recent, at: 2));
    await Future<void>.delayed(Duration.zero);
    pending.complete(jsonResponse([const SessionEvent(seq: 1, time: 1, type: SessionEventType.userMessage, text: 'old').toJson()]));
    expect((await c.read(sessionEventsProvider('s1').future)).map((e) => e.seq), [1, 2]);
    expect(server.requests, hasLength(1));
    expect(server.requests.single.url.path, '/api/v1/sessions/s1/events');
    first.close();
    second.close();
  });

  test('run identity keeps adjacent turns separate and excludes legacy events', () async {
    final events = [
      const SessionEvent(seq: 1, time: 1000, type: SessionEventType.toolCall, run: 'first', text: 'first tool'),
      const SessionEvent(seq: 2, time: 1100, type: SessionEventType.toolCall, run: 'second', text: 'second tool'),
      const SessionEvent(seq: 3, time: 1200, type: SessionEventType.toolCall, text: 'legacy'),
    ];
    final server = FakeServer((_) async => jsonResponse(events.map((e) => e.toJson()).toList()));
    final c = container(server);
    final keep = c.listen(runEventsProvider((session: 's', run: 'first')), (_, _) {});
    await c.read(sessionEventsProvider('s').future);
    expect(c.read(runEventsProvider((session: 's', run: 'first'))).requireValue.map((e) => e.text), ['first tool']);
    expect(c.read(runEventsProvider((session: 's', run: 'second'))).requireValue.map((e) => e.text), ['second tool']);
    keep.close();
  });

  test('a chat feed combines history with the server frame without duplicate messages', () {
    final server = FakeServer();
    const general = Conversation(id: 'general', kind: ConversationKind.general, replies: 0, at: 0);
    final c = container(
      server,
      state: CoreState(
        call: CallState.live,
        manager: ManagerState.listening,
        sessions: const [],
        chat: Chat(conversations: const [general], messages: [message('m2', 2, 'new')]),
      ),
    );
    c.read(chatLoadedProvider.notifier).set({
      'general': Loaded([message('m1', 1, 'old'), message('m2', 2, 'stale')], complete: true),
    });
    final feed = c.read(chatFeedProvider('general'));
    expect(feed.items.whereType<MessageItem>().map((i) => i.message.text), ['old', 'new']);
    expect(feed.hasOlder, isFalse);
    expect(feed.parent, isNull);
  });

  testWidgets('two visible views share one read receipt and a hidden conversation sends none', (t) async {
    final server = FakeServer((_) async => http.Response('', 204));
    const general = Conversation(id: 'general', kind: ConversationKind.general, replies: 0, at: 0, read: 0);
    final c = container(
      server,
      state: CoreState(
        call: CallState.live,
        manager: ManagerState.listening,
        sessions: const [],
        chat: Chat(conversations: const [general], messages: [message('m1', 1, 'hello')]),
      ),
    );
    await t.pumpWidget(UncontrolledProviderScope(container: c, child: const SizedBox()));
    expect(server.requests, isEmpty);
    Widget viewer() => Consumer(
      builder: (_, ref, _) {
        ref.watch(visibleConversationProvider('general'));
        return const SizedBox();
      },
    );
    await t.pumpWidget(
      UncontrolledProviderScope(
        container: c,
        child: Column(children: [viewer(), viewer()]),
      ),
    );
    await t.pump();
    expect(server.requests, hasLength(1));
    expect(server.requests.single.url.path, '/api/v1/channels/general/read');
    await t.pump();
    expect(server.requests, hasLength(1));
  });
}
