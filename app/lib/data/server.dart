// The vibevalley server (server), as the Flutter client sees it: the folded core state from GET /api/site/state, and
// the commands of VibeValleyApi through the generated client (gen/vibevalley.dart), and what happens beside the state from
// GET /api/site/events (steps, notices, runtimes). The client never folds facts itself:
// the server folds them and sends the whole state again when it changes (at most every 200 ms).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../gen/vibevalley.dart';

/// One frame off the stream (the folded state, its view, the effects since the last one), with what it cost to receive.
class StateFrame {
  StateFrame(this.frame, {required this.bytes, required this.decodeMicros});
  final SiteFrame frame;
  final int bytes;
  final int decodeMicros;

  FarmState get state => frame.state;
}

class VibeValleyServer {
  VibeValleyServer(this.base, {this.key}) : api = VibeValleyApi(base, key == null ? null : _Keyed(key));

  /// http://127.0.0.1:8787 by default: the server listens on loopback; another machine's farm through its yard gate.
  final Uri base;

  /// This device's key for another machine's yard gate (protocol LanPaired), sent with every request; null on loopback.
  final String? key;

  bool _closed = false;
  HttpClient? _streaming;

  /// Stops the streams and the commands' client: the app moved to another farm.
  void close() {
    _closed = true;
    _streaming?.close(force: true);
    api.close();
  }

  /// Every command: `server.api.farm.say(body: SayRequest(text: …))`.
  final VibeValleyApi api;

  /// Why the state stream is not coming through, each time an attempt fails for a reason other than "not up".
  final problems = StreamController<String>.broadcast();

  /// The frames, one connection for every listener: the latest state, its view and the effects as they come.
  late final Stream<StateFrame> frames = states().asBroadcastStream();

  /// What happens beside the core state, as it comes: a helper's steps (its detail panel), notices, runtimes' changes.
  /// Facts are left out: the state stream already brings them folded.
  late final Stream<SiteEvent> sideEvents = _events().where((e) => e is! Fact && e is! SiteEventSnapshot).asBroadcastStream();

  Stream<SiteEvent> _events() async* {
    await for (final text in _sse('/api/site/events')) {
      try {
        yield SiteEvent.fromJson(jsonDecode(text) as Map<String, dynamic>);
      } on Object catch (e) {
        problems.add('$e');
      }
    }
  }

  /// The folded state, again on every change; reconnects (and so starts from a fresh state) when the line drops.
  Stream<StateFrame> states() async* {
    await for (final text in _sse('/api/site/state')) {
      final watch = Stopwatch()..start();
      final frame = SiteFrame.fromJson(jsonDecode(text) as Map<String, dynamic>);
      yield StateFrame(frame, bytes: utf8.encode(text).length, decodeMicros: watch.elapsedMicroseconds);
    }
  }

  /// A server-sent event stream's data, one string per event; reconnects when the line drops.
  Stream<String> _sse(String path) async* {
    while (!_closed) {
      final client = _streaming = HttpClient();
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
        // An older server without /api/site/state, a bad frame, a key refused: said once per attempt, then tried again.
        if (!_closed) problems.add('$e');
      } finally {
        client.close(force: true);
      }
      if (_closed) return;
      await Future<void>.delayed(const Duration(seconds: 2));
    }
  }

  Future<bool> healthy() async {
    try {
      return (await api.farm.health().timeout(const Duration(seconds: 2))).ok;
    } catch (_) {
      return false;
    }
  }
}

/// What the farm says to a key it does not know (channels/lan.go), as the client says it.
const keyRefused = '那台电脑不认这台设备了：回那台电脑上打开院门，重新扫码配对';

/// Every command with this device's key on it.
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
