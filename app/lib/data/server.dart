import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../gen/vibevalley.dart';

class ReceivedFrame {
  ReceivedFrame(this.frame, {required this.bytes, required this.decodeMicros});
  final StateFrame frame;
  final int bytes;
  final int decodeMicros;

  CoreState get state => frame.state;
}

class VibeValleyServer {
  VibeValleyServer(this.base, {this.key}) : api = VibeValleyApi(base, key == null ? null : _Keyed(key));

  /// The server listens on loopback; another machine's farm comes through its yard gate.
  final Uri base;

  /// null on loopback.
  final String? key;

  bool _closed = false;
  final _streaming = <HttpClient>{};
  final _closedSignal = Completer<void>();

  void close() {
    if (_closed) return;
    _closed = true;
    _closedSignal.complete();
    for (final client in _streaming.toList()) {
      client.close(force: true);
    }
    api.close();
    unawaited(problems.close());
  }

  final VibeValleyApi api;

  /// Each time an attempt fails for a reason other than "not up".
  final problems = StreamController<String>.broadcast();

  late final Stream<ReceivedFrame> frames = states().asBroadcastStream();

  /// The server's own narrow stream: step, notice, runtime. No facts, no snapshot.
  late final Stream<LiveEvent> sideEvents = _live().asBroadcastStream();

  Stream<LiveEvent> _live() async* {
    await for (final text in _sse(livePath)) {
      try {
        if (!_closed) yield LiveEvent.fromJson(jsonDecode(text) as Map<String, dynamic>);
      } on Object catch (e) {
        if (!_closed) problems.add('$e');
      }
    }
  }

  /// Reconnects, and so starts from a fresh state, when the line drops.
  Stream<ReceivedFrame> states() async* {
    await for (final text in _sse(statePath)) {
      try {
        final watch = Stopwatch()..start();
        final frame = StateFrame.fromJson(jsonDecode(text) as Map<String, dynamic>);
        if (!_closed) yield ReceivedFrame(frame, bytes: utf8.encode(text).length, decodeMicros: watch.elapsedMicroseconds);
      } on Object catch (e) {
        if (!_closed) problems.add('$e');
      }
    }
  }

  Stream<String> _sse(String path) async* {
    while (!_closed) {
      final client = HttpClient();
      _streaming.add(client);
      try {
        final request = await client.getUrl(base.resolve(path));
        request.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        if (key != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $key');
        final response = await request.close();
        if (response.statusCode == HttpStatus.unauthorized) throw VibeValleyApiError(response.statusCode, 'LanRefused', keyRefused);
        if (response.statusCode != 200) throw VibeValleyApiError(response.statusCode, null, '$path ${response.statusCode}');
        final data = StringBuffer();
        // Server-sent events: `data:` lines up to a blank line are one event; `:` lines are pings.
        await for (final line in response.transform(utf8.decoder).transform(const LineSplitter())) {
          if (_closed) return;
          if (line.startsWith('data:')) {
            data.write(line.substring(line.startsWith('data: ') ? 6 : 5));
          } else if (line.isEmpty && data.isNotEmpty) {
            final text = data.toString();
            data.clear();
            yield text;
          }
        }
      } on SocketException {
        // The server is not up (yet): try again shortly.
      } on Object catch (e) {
        // An older server without /api/v1/state, a bad frame, a key refused: said once per attempt, then tried again.
        if (!_closed) problems.add('$e');
      } finally {
        client.close(force: true);
        _streaming.remove(client);
      }
      if (_closed) return;
      await Future.any([Future<void>.delayed(const Duration(seconds: 2)), _closedSignal.future]);
    }
  }

  Future<bool> healthy() async {
    try {
      return (await api.server.health().timeout(const Duration(seconds: 2))).ok;
    } catch (_) {
      return false;
    }
  }
}

const keyRefused = '那台电脑不认这台设备了：回那台电脑的「连接到本机」重新扫码配对';

class _Keyed extends http.BaseClient {
  _Keyed(this.key);
  final String key;
  final _inner = http.Client();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    request.headers[HttpHeaders.authorizationHeader] = 'Bearer $key';
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}

const connectWait = Duration(seconds: 20);
