import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/data/messages.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/remote.dart';
import 'package:vibevalley/game/commands.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/game/tools.dart' show BedFxKind;
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/issues/issue_submission.dart';
import 'package:vibevalley/workbench/projects/projects_state.dart';

import '../support/farm.dart' show session;
import '../support/server.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  ProviderContainer container(FakeServer server) {
    final c = ProviderContainer(
      overrides: [
        apiProvider.overrideWithValue(server.api),
        stateProvider.overrideWithValue(const CoreState(call: CallState.live, manager: ManagerState.listening, sessions: [])),
        agentsProvider.overrideWithValue(const AsyncData({})),
      ],
    );
    addTearDown(c.dispose);
    addTearDown(server.close);
    return c;
  }

  test('observing a project owns both statistics reads and preserves a partial success', () async {
    final activity = Completer<http.Response>();
    final server = FakeServer(
      (r) async => r.url.path.endsWith('/languages') ? jsonResponse(const ProjectLanguages(project: 'p', at: 1, languages: []).toJson()) : activity.future,
    );
    final c = container(server);
    final languagesReady = Completer<void>();
    final sub = c.listen(projectSurveyProvider('p'), (_, next) {
      if (next.languages is Done<ProjectLanguages> && !languagesReady.isCompleted) languagesReady.complete();
    });
    await languagesReady.future;
    expect(c.read(projectSurveyProvider('p')).activity, isA<Asking<ProjectActivity>>());
    final finished = c.read(projectSurveyProvider('p').notifier).refresh();
    activity.complete(http.Response('no activity', 503));
    await finished;
    expect(c.read(projectSurveyProvider('p')).languages, isA<Done<ProjectLanguages>>());
    expect(c.read(projectSurveyProvider('p')).activity, isA<Failed<ProjectActivity>>());
    expect(server.requests, hasLength(2));
    sub.close();
  });

  test('changes are read once for simultaneous reviewers and reread only after they leave', () async {
    const changes = Changes(project: 'p', base: 'main', commits: [], files: [], uncommitted: [], conflicts: [], behind: 0);
    final server = FakeServer((_) async => jsonResponse(changes.toJson()));
    final c = container(server);
    final first = c.listen(issueChangesProvider('i'), (_, _) {});
    final second = c.listen(issueChangesProvider('i'), (_, _) {});
    await c.read(issueChangesProvider('i').future);
    expect(server.requests, hasLength(1));
    await c.pump();
    expect(server.requests, hasLength(1));
    first.close();
    second.close();
    await c.pump();
    final next = c.listen(issueChangesProvider('i'), (_, _) {});
    await c.read(issueChangesProvider('i').future);
    expect(server.requests, hasLength(2));
    next.close();
  });

  test('a farm command emits its effect only after the server accepts it', () async {
    final response = Completer<http.Response>();
    final server = FakeServer((_) => response.future);
    final c = container(server);
    final command = c.read(farmCommandsProvider).water(session('s', station: 1), '继续');
    expect(c.read(bedFxProvider), isEmpty);
    response.complete(http.Response('', 204));
    await command;
    expect(c.read(bedFxProvider).single.kind, BedFxKind.water);
    expect(c.read(bedFxProvider).single.bed, 1);
  });

  test('a rejected farm command has no success effect', () async {
    final c = container(FakeServer((_) async => jsonResponse({'reason': 'rejected'}, 503)));
    await expectLater(c.read(farmCommandsProvider).water(session('s'), '继续'), throwsA(isA<VibeValleyApiError>()));
    expect(c.read(bedFxProvider), isEmpty);
  });

  test('dispatch failure keeps the saved issue and retry updates that same issue', () async {
    const issue = Issue(id: 'i', number: 1, title: '工作', priority: Priority.medium, createdAt: 1, sessions: [], status: IssueStatus.todo);
    var starts = 0;
    final server = FakeServer((r) async {
      if (r.url.path.endsWith('/start')) {
        return ++starts == 1 ? jsonResponse({'reason': 'dispatch failed'}, 503) : jsonResponse(const Dispatched(session: 's').toJson());
      }
      return jsonResponse(issue.toJson());
    });
    addTearDown(server.close);
    final submission = IssueSubmission(server.api.issue);
    const request = IssueRequest(title: '工作', project: 'p', assignee: 'helper');
    await expectLater(submission.start(request), throwsA(isA<VibeValleyApiError>()));
    expect(submission.saved?.id, 'i');
    expect((await submission.start(request)).session, 's');
    expect(server.requests.map((r) => '${r.method} ${r.url.path}'), [
      'POST /api/v1/issues',
      'POST /api/v1/issues/i/start',
      'PUT /api/v1/issues/i',
      'POST /api/v1/issues/i/start',
    ]);
    expect(await IssueSubmission.remembered(), (agent: 'helper', project: 'p'));
  });

  test('chat and planting share text delivery while preserving their target', () async {
    final server = FakeServer((_) async => http.Response('', 204));
    final c = container(server);
    await c
        .read(messagesProvider)
        .send(
          '  hello  ',
          conversation: const Conversation(id: 'c', kind: ConversationKind.channel, replies: 0, at: 0),
        );
    await c.read(farmCommandsProvider).plant(2, 'seed', 'helper');
    expect(server.requests.map((r) => jsonDecode(r.body)), [
      {'text': 'hello', 'conversation': 'c'},
      {'text': 'seed', 'bed': 2, 'agent': 'helper'},
    ]);
  });
}
