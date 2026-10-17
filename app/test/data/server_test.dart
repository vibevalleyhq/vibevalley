import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';

void main() {
  test('closing the farm terminates both live connections and the problem stream', () async {
    final http = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => http.close(force: true));
    final connected = <String, Completer<void>>{statePath: Completer<void>(), livePath: Completer<void>()};
    http.listen((request) async {
      request.response.bufferOutput = false;
      request.response.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
      request.response.write(': ready\n\n');
      await request.response.flush();
      connected[request.uri.path]!.complete();
    });
    final server = VibeValleyServer(Uri.parse('http://127.0.0.1:${http.port}'));
    addTearDown(server.close);
    final framesDone = Completer<void>();
    final liveDone = Completer<void>();
    final problemsDone = Completer<void>();
    final subscriptions = [
      server.frames.listen((_) => fail('unexpected frame'), onDone: framesDone.complete),
      server.sideEvents.listen((_) => fail('unexpected event'), onDone: liveDone.complete),
      server.problems.stream.listen((_) => fail('close must not report a problem'), onDone: problemsDone.complete),
    ];
    addTearDown(() async {
      for (final sub in subscriptions) {
        await sub.cancel();
      }
    });
    await Future.wait(connected.values.map((c) => c.future)).timeout(const Duration(seconds: 3));
    server.close();
    server.close();
    await Future.wait([framesDone.future, liveDone.future, problemsDone.future]).timeout(const Duration(seconds: 3));
  });

  test('a malformed state reports a problem and the next frame still arrives', () async {
    final http = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => http.close(force: true));
    final sample = File('test/fixtures/state-frame.sample.json').readAsStringSync();
    http.listen((request) async {
      request.response.bufferOutput = false;
      request.response.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
      request.response.write('data: {broken\n\ndata: ${jsonEncode(jsonDecode(sample))}\n\n');
      await request.response.flush();
    });
    final server = VibeValleyServer(Uri.parse('http://127.0.0.1:${http.port}'));
    addTearDown(server.close);
    final problem = server.problems.stream.first;
    final frame = server.frames.first;
    expect(await problem.timeout(const Duration(seconds: 3)), contains('FormatException'));
    expect((await frame.timeout(const Duration(seconds: 3))).frame.toJson(), jsonDecode(sample));
  });
}
