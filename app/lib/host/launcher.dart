// SIGTERM first: the server saves on the way out. Plain dart:io, no Flutter: test/host/launcher_test.dart drives it with a fake server script.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../gen/vibevalley.dart' show ServerReady;

class ServerFailed implements Exception {
  ServerFailed(this.reason);
  final String reason;

  @override
  String toString() => reason;
}

class ServerStartCanceled extends ServerFailed {
  ServerStartCanceled() : super('服务端启动已取消');
}

class RunningServer {
  RunningServer._(this.process, this._log, this._stopTimeout) {
    process.exitCode.then((code) => _exit.complete(code));
  }

  final Process process;

  /// No trailing slash.
  late final Uri url;
  final _ready = Completer<void>();
  final IOSink _log;

  late final Future<void> _drained;
  final Duration _stopTimeout;
  final _exit = Completer<int>();
  Future<void>? _stopping;

  void _acceptReady(String line) {
    if (_ready.isCompleted) return;
    try {
      final ready = ServerReady.fromJson(jsonDecode(line) as Map<String, dynamic>);
      final address = Uri.parse(ready.url);
      if (ready.pid != process.pid || address.scheme != 'http' || address.host != '127.0.0.1' || address.port <= 0 || address.port > 65535) return;
      url = address;
      _ready.complete();
    } on Object {
      // A child may write unrelated output; only its readiness receipt starts the farm.
    }
  }

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
  });

  final String binary;

  /// Not added to this process's: VIBEVALLEY_PORT is set on top of it.
  final Map<String, String> environment;
  final File logFile;
  final String workingDirectory;

  /// The first start builds the database: it may take a while.
  final Duration startTimeout;
  final Duration stopTimeout;
  RunningServer? _server;
  Future<RunningServer>? _starting;
  Future<void>? _stopping;
  final _canceled = Completer<void>();

  Future<RunningServer> start() => _starting ??= _start();

  /// The same owner can be stopped before spawn, while waiting for readiness, or after startup.
  Future<void> stop() => _stopping ??= _stop();

  Future<void> _stop() async {
    _canceled.complete();
    await _server?.stop();
    try {
      await _starting;
    } on Object {
      /* Cancellation still waits for a pending spawn to release its process. */
    }
  }

  Future<RunningServer> _start() async {
    if (_canceled.isCompleted) throw ServerStartCanceled();
    final RunningServer server;
    try {
      server = await _spawn();
    } on Object {
      if (_canceled.isCompleted) throw ServerStartCanceled();
      rethrow;
    }
    _server = server;
    final failure = await Future.any<ServerFailed?>([
      server._ready.future.then((_) => null),
      _canceled.future.then((_) => ServerStartCanceled()),
      server.exited.then((code) => ServerFailed('服务端退出了（$code），日志在 ${logFile.path}')),
    ]).timeout(startTimeout, onTimeout: () => ServerFailed('服务端 ${startTimeout.inSeconds} 秒内没有发布就绪地址，日志在 ${logFile.path}'));
    if (failure == null && !_canceled.isCompleted) return server;
    await server.stop();
    throw _canceled.isCompleted ? ServerStartCanceled() : failure!;
  }

  Future<RunningServer> _spawn() async {
    await logFile.parent.create(recursive: true);
    final log = logFile.openWrite(mode: FileMode.append);
    log.writeln('--- ${DateTime.now().toIso8601String()} vibevalley: starting $binary with a server-assigned port');
    try {
      await log.flush();
      final process = await Process.start(
        binary,
        const ['--ready-json'],
        workingDirectory: workingDirectory,
        environment: {...environment, 'VIBEVALLEY_PORT': '0'},
        includeParentEnvironment: false,
      );
      final server = RunningServer._(process, log, stopTimeout);
      server._drained = Future.wait([
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
          log.writeln(line);
          server._acceptReady(line);
        }),
        process.stderr.forEach(log.add),
      ]).then<void>((_) {}, onError: (_) {});
      return server;
    } on Object catch (error) {
      try {
        await log.close();
      } on Object {
        // Report the launch failure even when the log cannot be closed.
      }
      throw ServerFailed('服务端启动失败：$error，日志在 ${logFile.path}');
    }
  }
}

/// An interactive shell may print a greeting first.
const _mark = '__VIBEVALLEY_PATH__';

/// An app opened from Finder or at login gets a bare PATH, without the places pi, claude and codex are installed.
Future<String> loginShellPath(String fallback, {String? shell, Duration timeout = const Duration(seconds: 5)}) async {
  Process? process;
  StreamSubscription<String>? output;
  StreamSubscription<List<int>>? errors;
  try {
    process = await Process.start(shell ?? Platform.environment['SHELL'] ?? '/bin/zsh', ['-ilc', "printf '$_mark%s$_mark' \"\$PATH\""]);
    final text = StringBuffer();
    final drained = Completer<void>();
    output = process.stdout.transform(utf8.decoder).listen(text.write, onDone: drained.complete, onError: drained.completeError, cancelOnError: true);
    errors = process.stderr.listen((_) {});
    await Future.wait([process.exitCode, drained.future]).timeout(timeout);
    final match = RegExp('$_mark(.*)$_mark', dotAll: true).firstMatch(text.toString());
    return match?.group(1) ?? fallback;
  } on Object {
    process?.kill(ProcessSignal.sigkill);
    await process?.exitCode;
    return fallback;
  } finally {
    await output?.cancel();
    await errors?.cancel();
  }
}
