import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/issues/issue_submission.dart';

import '../support/server.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  test('optional preference storage cannot block dispatch after a successful save', () async {
    const channel = MethodChannel('plugins.flutter.io/shared_preferences');
    final entered = Completer<void>();
    final release = Completer<bool>();
    SharedPreferences.resetStatic();
    binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'getAll') return <String, Object>{};
      if (call.method == 'setStringList') {
        entered.complete();
        return release.future;
      }
      throw StateError('unexpected preference call: ${call.method}');
    });
    addTearDown(() {
      binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
      SharedPreferences.resetStatic();
    });
    const issue = Issue(id: 'i', number: 1, title: 'work', priority: Priority.medium, createdAt: 1, sessions: [], status: IssueStatus.todo);
    final server = FakeServer((r) async => jsonResponse(r.url.path.endsWith('/start') ? const Dispatched(session: 's').toJson() : issue.toJson()));
    addTearDown(server.close);
    final sending = IssueSubmission(server.api.issue).start(const IssueRequest(title: 'work', assignee: 'helper'));
    await entered.future.timeout(const Duration(seconds: 2));
    try {
      expect((await sending.timeout(const Duration(seconds: 1))).session, 's');
      expect(server.requests.last.url.path, '/api/v1/issues/i/start');
    } finally {
      release.complete(true);
    }
  });
}
