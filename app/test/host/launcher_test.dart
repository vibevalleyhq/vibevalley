@TestOn('mac-os || linux')
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/launcher.dart';
import 'package:vibevalley/gen/vibevalley.dart';

const _answering = r'''#!/bin/sh
echo "fake farm: home=$VIBEVALLEY_HOME work=$VIBEVALLEY_WORK_ROOT port=$VIBEVALLEY_PORT mode=$1"
echo $$ > "$VIBEVALLEY_HOME.pid"
exec python3 -c '
import http.server, os, sys, json, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == "/api/v1/health"
        self.send_response(200 if ok else 404)
        self.end_headers()
        self.wfile.write(b"{\"ok\":true,\"version\":\"fake\"}" if ok else b"")
    def log_message(self, *a): pass
server = http.server.HTTPServer(("127.0.0.1", int(os.environ["VIBEVALLEY_PORT"])), H)
open(os.environ["VIBEVALLEY_HOME"] + ".pid", "w").write(str(os.getpid()))
print("fake farm: listening; this sentence is not a protocol", flush=True)
print(json.dumps({"note": "noise before readiness"}), flush=True)
time.sleep(float(os.environ.get("TEST_READY_DELAY", "0")))
if os.environ.get("TEST_NO_READY") != "1":
    ready = json.dumps({"url": "http://127.0.0.1:" + str(65536 if os.environ.get("TEST_BAD_PORT") else server.server_port), "pid": -1 if os.environ.get("TEST_WRONG_PID") else os.getpid()})
    middle = len(ready) // 2
    sys.stdout.write(ready[:middle]); sys.stdout.flush()
    time.sleep(0.02)
    sys.stdout.write(ready[middle:] + "\n"); sys.stdout.flush()
server.serve_forever()
'
''';

Future<File> _script(Directory dir, String name, String body) async {
  final file = File('${dir.path}/$name');
  await file.writeAsString(body);
  await Process.run('chmod', ['+x', file.path]);
  return file;
}

bool _alive(int pid) => Process.runSync('kill', ['-0', '$pid']).exitCode == 0;

Future<bool> _healthy(Uri url) async {
  final api = VibeValleyApi(url);
  try {
    return (await api.server.health().timeout(const Duration(seconds: 1))).ok;
  } on Object {
    return false;
  } finally {
    api.close();
  }
}

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('vibevalley-launcher-'));
  tearDown(() async => dir.delete(recursive: true));

  ServerLauncher launcher(
    File binary, {
    Duration startTimeout = const Duration(seconds: 10),
    Duration stopTimeout = const Duration(seconds: 3),
    Map<String, String> extraEnvironment = const {},
  }) => ServerLauncher(
    binary: binary.path,
    environment: {
      ...extraEnvironment,
      'PATH': Platform.environment['PATH'] ?? '/usr/bin:/bin',
      'VIBEVALLEY_HOME': '${dir.path}/home',
      'VIBEVALLEY_WORK_ROOT': '${dir.path}/work',
    },
    logFile: File('${dir.path}/logs/server.log'),
    workingDirectory: dir.path,
    startTimeout: startTimeout,
    stopTimeout: stopTimeout,
  );

  test('starts with the child-assigned port and receipt despite log noise, then releases it', () async {
    final server = await launcher(await _script(dir, 'farm', _answering)).start();
    expect(server.url.host, '127.0.0.1');
    expect(await _healthy(server.url), isTrue);
    expect(_alive(server.pid), isTrue);
    await server.stop();
    expect(server.hasExited, isTrue);
    expect(_alive(server.pid), isFalse);
    expect(await _healthy(server.url), isFalse);
    final log = await File('${dir.path}/logs/server.log').readAsString();
    expect(log, contains('fake farm: home=${dir.path}/home work=${dir.path}/work port=0 mode=--ready-json'));
    expect(log, contains('fake farm: listening'));
    await server.stop();
  });

  test('a server that exits before readiness fails once and keeps its diagnostic log', () async {
    final failing = launcher(await _script(dir, 'broken', '#!/bin/sh\necho "no database" >&2\nexit 3\n'));
    await expectLater(failing.start(), throwsA(isA<ServerFailed>().having((e) => e.reason, 'reason', allOf(contains('退出了（3）'), contains('server.log')))));
    expect(RegExp('no database').allMatches(await File('${dir.path}/logs/server.log').readAsString()), hasLength(1));
  });

  for (final flag in ['TEST_NO_READY', 'TEST_WRONG_PID', 'TEST_BAD_PORT']) {
    test('a healthy listener without its own readiness receipt times out and is stopped: $flag', () async {
      final binary = await _script(dir, 'unannounced', _answering);
      await expectLater(
        launcher(binary, startTimeout: const Duration(seconds: 2), extraEnvironment: {flag: '1'}).start(),
        throwsA(isA<ServerFailed>().having((e) => e.reason, 'reason', contains('没有发布就绪地址'))),
      );
      expect(await File('${dir.path}/logs/server.log').readAsString(), contains('fake farm: listening'));
      final pid = int.parse(await File('${dir.path}/home.pid').readAsString());
      expect(_alive(pid), isFalse);
    });
  }

  test('quitting while the child is waiting to publish readiness releases the pending process', () async {
    final pending = launcher(await _script(dir, 'pending', _answering), extraEnvironment: {'TEST_READY_DELAY': '5'});
    final startup = expectLater(pending.start(), throwsA(isA<ServerStartCanceled>()));
    final pidFile = File('${dir.path}/home.pid');
    final deadline = DateTime.now().add(const Duration(seconds: 3));
    while (!await pidFile.exists()) {
      if (DateTime.now().isAfter(deadline)) fail('fake child did not start');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    final pid = int.parse(await pidFile.readAsString());
    expect(_alive(pid), isTrue);
    await pending.stop();
    await startup;
    expect(_alive(pid), isFalse);
    await pending.stop();
  });

  test('stop also owns a spawn that has not finished yet', () async {
    final pending = launcher(await _script(dir, 'spawn-race', _answering));
    final startup = expectLater(pending.start(), throwsA(isA<ServerStartCanceled>()));
    await pending.stop();
    await startup;
    final pidFile = File('${dir.path}/home.pid');
    if (await pidFile.exists()) expect(_alive(int.parse(await pidFile.readAsString())), isFalse);
  });

  test('cancellation wins over a pending spawn failure without presenting a startup error', () async {
    final pending = launcher(File('${dir.path}/missing-during-quit'));
    final startup = expectLater(pending.start(), throwsA(isA<ServerStartCanceled>()));
    await pending.stop();
    await startup;
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

  test('a missing binary produces a launch failure naming its log', () async {
    await expectLater(launcher(File('${dir.path}/missing')).start(), throwsA(isA<ServerFailed>().having((e) => e.reason, 'reason', contains('server.log'))));
  });

  test('a timed out login shell is killed', () async {
    final pidFile = File('${dir.path}/shell.pid');
    final shell = await _script(dir, 'shell', '#!/bin/sh\necho \$\$ > "${pidFile.path}"\nexec sleep 30\n');
    expect(await loginShellPath('/fallback', shell: shell.path, timeout: const Duration(seconds: 1)), '/fallback');
    final pid = int.parse((await pidFile.readAsString()).trim());
    expect(_alive(pid), isFalse);
  });

  test('invalid UTF-8 from a login shell falls back without an uncaught completion error', () async {
    final shell = await _script(dir, 'bad-output', r"""#!/bin/sh
printf '\377'
""");
    expect(await loginShellPath('/fallback', shell: shell.path), '/fallback');
  });

  test('loginShellPath falls back when the shell cannot be asked', () async {
    expect(await loginShellPath('/fallback', shell: '${dir.path}/no-such-shell'), '/fallback');
  });
}

// Process.exitCode is minus the signal's number for a process killed by one.
const _sigkill = 9;
