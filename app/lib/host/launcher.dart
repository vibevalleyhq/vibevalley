// SIGTERM first: the server saves on the way out. Plain dart:io, no Flutter: test/desktop_launcher_test.dart drives it with a fake server script.

import 'dart:async';
import 'dart:io';

class ServerFailed implements Exception {
  ServerFailed(this.reason);
  final String reason;

  @override
  String toString() => reason;
}

/// Another process may take it before the server binds it: `ServerLauncher.start` tries again with a new one when the server exits early.
Future<int> freeLoopbackPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

Future<bool> answersHealth(Uri base, {Duration timeout = const Duration(milliseconds: 1500)}) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final request = await client.getUrl(base.resolve('/api/v1/health')).timeout(timeout);
    final response = await request.close().timeout(timeout);
    await response.drain<void>();
    return response.statusCode == 200;
  } on Object {
    return false;
  } finally {
    client.close(force: true);
  }
}

class RunningServer {
  RunningServer._(this.process, this.url, this._log, this._drained, this._stopTimeout) {
    process.exitCode.then((code) => _exit.complete(code));
  }

  final Process process;

  /// No trailing slash.
  final Uri url;
  final IOSink _log;

  final Future<void> _drained;
  final Duration _stopTimeout;
  final _exit = Completer<int>();
  Future<void>? _stopping;

  int get pid => process.pid;

  Future<int> get exited => _exit.future;
  bool get hasExited => _exit.isCompleted;

  /// Safe to call more than once.
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

  /// Not added to this process's: VIBEVALLEY_PORT is set on top of it.
  final Map<String, String> environment;
  final File logFile;
  final String workingDirectory;

  /// The first start builds the database: it may take a while.
  final Duration startTimeout;
  final Duration stopTimeout;
  final Duration pollInterval;

  /// The port may be taken in between.
  final int attempts;
  final Future<int> Function() pickPort;

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
      environment: {...environment, 'VIBEVALLEY_PORT': '$port'},
      includeParentEnvironment: false,
    );
    final drained = Future.wait([process.stdout.forEach(log.add), process.stderr.forEach(log.add)]).then<void>((_) {}, onError: (_) {});
    return RunningServer._(process, Uri.parse('http://127.0.0.1:$port'), log, drained, stopTimeout);
  }

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

/// An interactive shell may print a greeting first.
const _mark = '__VIBEVALLEY_PATH__';

/// An app opened from Finder or at login gets a bare PATH, without the places pi, claude and codex are installed.
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
