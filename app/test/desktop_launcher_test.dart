@TestOn('mac-os || linux')
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/launcher.dart';

const _answering = r'''#!/bin/sh
echo "fake farm: home=$VIBEVALLEY_HOME work=$VIBEVALLEY_WORK_ROOT port=$VIBEVALLEY_PORT"
exec python3 -c '
import http.server, os, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == "/api/v1/health"
        self.send_response(200 if ok else 404)
        self.end_headers()
        self.wfile.write(b"{\"ok\":true,\"version\":\"fake\"}" if ok else b"")
    def log_message(self, *a): pass
print("fake farm: listening", flush=True)
http.server.HTTPServer(("127.0.0.1", int(os.environ["VIBEVALLEY_PORT"])), H).serve_forever()
'
''';

Future<File> _script(Directory dir, String name, String body) async {
  final file = File('${dir.path}/$name');
  await file.writeAsString(body);
  await Process.run('chmod', ['+x', file.path]);
  return file;
}

bool _alive(int pid) => Process.runSync('kill', ['-0', '$pid']).exitCode == 0;

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('vibevalley-launcher-'));
  tearDown(() async => dir.delete(recursive: true));

  ServerLauncher launcher(File binary, {Duration startTimeout = const Duration(seconds: 10), Duration stopTimeout = const Duration(seconds: 3)}) =>
      ServerLauncher(
        binary: binary.path,
        environment: {
          'PATH': Platform.environment['PATH'] ?? '/usr/bin:/bin',
          'VIBEVALLEY_HOME': '${dir.path}/home',
          'VIBEVALLEY_WORK_ROOT': '${dir.path}/work',
        },
        logFile: File('${dir.path}/logs/server.log'),
        workingDirectory: dir.path,
        startTimeout: startTimeout,
        stopTimeout: stopTimeout,
        pollInterval: const Duration(milliseconds: 100),
      );

  test('a free loopback port can be bound', () async {
    final port = await freeLoopbackPort();
    expect(port, greaterThan(0));
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, port);
    await socket.close();
  });

  test('starts the server on a free port, waits for its health, logs its output, stops it with SIGTERM', () async {
    final server = await launcher(await _script(dir, 'farm', _answering)).start();
    expect(server.url.host, '127.0.0.1');
    expect(await answersHealth(server.url), isTrue);
    expect(_alive(server.pid), isTrue);
    await server.stop();
    expect(server.hasExited, isTrue);
    expect(_alive(server.pid), isFalse);
    expect(await answersHealth(server.url), isFalse);
    final log = await File('${dir.path}/logs/server.log').readAsString();
    expect(log, contains('fake farm: home=${dir.path}/home work=${dir.path}/work port=${server.url.port}'));
    expect(log, contains('fake farm: listening'));
    await server.stop();
  });

  test('a server that exits first fails the start, naming the log, after trying other ports', () async {
    var picked = 0;
    final failing = ServerLauncher(
      binary: (await _script(dir, 'broken', '#!/bin/sh\necho "no database" >&2\nexit 3\n')).path,
      environment: const {},
      logFile: File('${dir.path}/logs/server.log'),
      workingDirectory: dir.path,
      pollInterval: const Duration(milliseconds: 50),
      pickPort: () {
        picked++;
        return freeLoopbackPort();
      },
    );
    await expectLater(
      failing.start(),
      throwsA(isA<ServerFailed>().having((e) => e.reason, 'reason', allOf(contains('退出了（3）'), contains('${dir.path}/logs/server.log')))),
    );
    expect(picked, 3);
    expect(await File('${dir.path}/logs/server.log').readAsString(), contains('no database'));
  });

  test('a server that never answers times out and is stopped', () async {
    final silent = await _script(dir, 'silent', '#!/bin/sh\nexec sleep 30\n');
    final start = launcher(silent, startTimeout: const Duration(milliseconds: 600)).start();
    await expectLater(start, throwsA(isA<ServerFailed>().having((e) => e.reason, 'reason', contains('秒内没起来'))));
    final pids = Process.runSync('pgrep', ['-f', silent.path]).stdout.toString().trim();
    expect(pids, isEmpty);
  });

  test('a server that ignores SIGTERM is killed after the stop timeout', () async {
    final stubborn = await _script(dir, 'stubborn', "#!/bin/sh\ntrap '' TERM\n${_answering.split('\n').skip(1).join('\n')}");
    final server = await launcher(stubborn, stopTimeout: const Duration(milliseconds: 500)).start();
    final watch = Stopwatch()..start();
    await server.stop();
    expect(watch.elapsed, greaterThanOrEqualTo(const Duration(milliseconds: 500)));
    expect(await server.exited, -_sigkill);
    expect(_alive(server.pid), isFalse);
  });

  test('loginShellPath falls back when the shell cannot be asked', () async {
    expect(await loginShellPath('/fallback', shell: '${dir.path}/no-such-shell'), '/fallback');
  });
}

// Process.exitCode is minus the signal's number for a process killed by one.
const _sigkill = 9;
