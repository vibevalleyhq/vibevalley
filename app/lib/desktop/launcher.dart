// The farm inside the desktop app: the Go server (server/cmd/vibevalley, in the bundle as
// Contents/MacOS/vibevalley-server) started as a child process on a free loopback port, waited for until /api/health
// answers, and stopped when the app quits: SIGTERM first (the server saves on the way out), killed if it takes too
// long. Plain dart:io, no Flutter: test/desktop_launcher_test.dart drives it with a fake server script.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Where the client finds the farm when the desktop app started one; null otherwise (data/providers.dart then uses
/// VIBEVALLEY_SERVER or http://127.0.0.1:8787). Set by `startDesktop` before the app's first frame.
String? embeddedServerAddress;

/// Why the embedded server is not answering: the words are shown to the person.
class ServerFailed implements Exception {
  ServerFailed(this.reason);
  final String reason;

  @override
  String toString() => reason;
}

/// A free port on 127.0.0.1, as the system hands one out. Another process may take it before the server binds it:
/// `ServerLauncher.start` tries again with a new one when the server exits early.
Future<int> freeLoopbackPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

/// Whether a farm answers GET /api/health at `base` with a 200.
Future<bool> answersHealth(Uri base, {Duration timeout = const Duration(milliseconds: 1500)}) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final request = await client.getUrl(base.resolve('/api/health')).timeout(timeout);
    final response = await request.close().timeout(timeout);
    await response.drain<void>();
    return response.statusCode == 200;
  } on Object {
    return false;
  } finally {
    client.close(force: true);
  }
}

/// One started server: where it answers, and how to stop it.
class RunningServer {
  RunningServer._(this.process, this.url, this._log, this._drained, this._stopTimeout) {
    process.exitCode.then((code) => _exit.complete(code));
  }

  final Process process;

  /// `http://127.0.0.1:PORT`, no trailing slash.
  final Uri url;
  final IOSink _log;

  /// The output streams, written to the log until they end: the log closes after them.
  final Future<void> _drained;
  final Duration _stopTimeout;
  final _exit = Completer<int>();
  Future<void>? _stopping;

  int get pid => process.pid;

  /// Completes with the exit code once the process is gone.
  Future<int> get exited => _exit.future;
  bool get hasExited => _exit.isCompleted;

  /// SIGTERM, then SIGKILL if it is still there after the stop timeout. Safe to call more than once.
  Future<void> stop() => _stopping ??= _stop();

  Future<void> _stop() async {
    if (!hasExited) {
      process.kill(ProcessSignal.sigterm);
      try {
        await exited.timeout(_stopTimeout);
      } on TimeoutException {
        process.kill(ProcessSignal.sigkill);
        await exited;
      }
    }
    await _drained.timeout(const Duration(seconds: 2), onTimeout: () {});
    await _log.close();
  }
}

/// How to start the server: which binary, with what environment, where its output goes.
class ServerLauncher {
  ServerLauncher({
    required this.binary,
    required this.environment,
    required this.logFile,
    required this.workingDirectory,
    this.startTimeout = const Duration(seconds: 40),
    this.stopTimeout = const Duration(seconds: 8),
    this.pollInterval = const Duration(milliseconds: 300),
    this.attempts = 3,
    this.pickPort = freeLoopbackPort,
  });

  final String binary;

  /// The child's whole environment (not added to this process's): PORT is set on top of it.
  final Map<String, String> environment;
  final File logFile;
  final String workingDirectory;

  /// The first start builds the database: it may take a while.
  final Duration startTimeout;
  final Duration stopTimeout;
  final Duration pollInterval;

  /// How many ports are tried when the server exits before answering (the port was taken in between).
  final int attempts;
  final Future<int> Function() pickPort;

  /// Starts the server and waits until it answers. Fails with a ServerFailed naming the log.
  Future<RunningServer> start() async {
    ServerFailed? last;
    for (var i = 0; i < attempts; i++) {
      final port = await pickPort();
      final server = await _spawn(port);
      final failure = await _waitUntilUp(server);
      if (failure == null) return server;
      final exitedEarly = server.hasExited;
      await server.stop();
      last = failure;
      // Only an early exit is worth another port; a server that never answers will not answer on another.
      if (!exitedEarly) break;
    }
    throw last ?? ServerFailed('服务端没起来，日志在 ${logFile.path}');
  }

  Future<RunningServer> _spawn(int port) async {
    await logFile.parent.create(recursive: true);
    final log = logFile.openWrite(mode: FileMode.append);
    log.writeln('--- ${DateTime.now().toIso8601String()} vibevalley: starting $binary on 127.0.0.1:$port');
    final process = await Process.start(
      binary,
      const [],
      workingDirectory: workingDirectory,
      environment: {...environment, 'PORT': '$port'},
      includeParentEnvironment: false,
    );
    final drained = Future.wait([process.stdout.forEach(log.add), process.stderr.forEach(log.add)]).then<void>((_) {}, onError: (_) {});
    return RunningServer._(process, Uri.parse('http://127.0.0.1:$port'), log, drained, stopTimeout);
  }

  /// Null once it answers; the reason otherwise (it exited, or took too long).
  Future<ServerFailed?> _waitUntilUp(RunningServer server) async {
    final deadline = DateTime.now().add(startTimeout);
    while (true) {
      if (server.hasExited) return ServerFailed('服务端退出了（${await server.exited}），日志在 ${logFile.path}');
      if (await answersHealth(server.url)) return null;
      if (DateTime.now().isAfter(deadline)) return ServerFailed('服务端 ${startTimeout.inSeconds} 秒内没起来，日志在 ${logFile.path}');
      await Future.any([Future<void>.delayed(pollInterval), server.exited]);
    }
  }
}

/// KEY=VALUE lines of a .env file (the dotenv way of writing, as cmd/vibevalley reads it): comments, blank lines and `export ` skipped,
/// one pair of surrounding quotes taken off.
Map<String, String> parseEnv(String text) {
  final out = <String, String>{};
  for (final raw in const LineSplitter().convert(text)) {
    var line = raw.trim();
    if (line.isEmpty || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.substring(7).trimLeft();
    final eq = line.indexOf('=');
    if (eq <= 0) continue;
    final key = line.substring(0, eq).trim();
    var value = line.substring(eq + 1).trim();
    if (value.length >= 2 && (value[0] == '"' || value[0] == "'") && value[value.length - 1] == value[0]) {
      value = value.substring(1, value.length - 1);
    } else {
      final hash = value.indexOf(' #');
      if (hash >= 0) value = value.substring(0, hash).trimRight();
    }
    out[key] = value;
  }
  return out;
}

/// Around the PATH in the shell's output: an interactive shell may print a greeting first.
const _mark = '__VIBEVALLEY_PATH__';

/// The login shell's PATH: an app opened from Finder or at login gets a bare one, without the places pi, claude and
/// codex are installed. The given fallback when the shell cannot be asked.
Future<String> loginShellPath(String fallback, {String? shell}) async {
  try {
    final result = await Process.run(shell ?? Platform.environment['SHELL'] ?? '/bin/zsh', [
      '-ilc',
      "printf '$_mark%s$_mark' \"\$PATH\"",
    ]).timeout(const Duration(seconds: 5));
    final match = RegExp('$_mark(.*)$_mark', dotAll: true).firstMatch('${result.stdout}');
    return match?.group(1) ?? fallback;
  } on Object {
    return fallback;
  }
}
