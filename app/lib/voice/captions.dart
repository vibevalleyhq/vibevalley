// The live captions of a call, from the conversational AI agent's messages on the RTC data stream (the server starts
// it with data_channel: 'datastream' for this client). A message comes in chunks, `id|part|parts|base64`, 1-based;
// put together and decoded, it is JSON with an `object`:
//   user.transcription       what you said so far in a turn; `final` when the turn is over
//   assistant.transcription  what the manager has said so far; `turn_status` 0 while it is still talking
//   message.interrupt        you talked over the manager: its turn `turn_id` stops there
//   message.state            the agent's state: idle, listening, thinking, speaking, silent
//   message.metrics          latencies (ignored here)
// Every message of a turn carries the whole text so far, so a turn's caption is replaced, never appended to.
// Follows agora-agent-client-toolkit (ChunkedMessageAssembler, text mode), which the web client uses.

import 'dart:convert';

enum Speaker { you, manager }

class Caption {
  Caption(this.speaker, this.turn, this.text, {this.done = false, this.interrupted = false});
  final Speaker speaker;
  final int turn;
  String text;
  bool done;
  bool interrupted;
}

class LiveCaptions {
  final turns = <Caption>[];

  String? agentState;
  final _chunks = <String, Map<int, String>>{};

  /// Said once per turn.
  void Function(String text)? onHeard;
  final _heard = <int>{};

  /// The manager's words of a turn, once the turn is over or talked over: what it got to say.
  void Function(String text)? onAnswered;
  final _answered = <int>{};

  static const keep = 8;

  bool feed(String packet) {
    final message = _assemble(packet);
    if (message == null) return false;
    return apply(message);
  }

  bool apply(Map<String, dynamic> m) {
    final turn = (m['turn_id'] as num?)?.toInt() ?? 0;
    switch (m['object']) {
      case 'user.transcription':
        // Ends on `final`, or on turn_status as the official quickstart reads it.
        _put(Speaker.you, turn, m['text'] as String? ?? '', done: m['final'] == true || (m['turn_status'] as num? ?? 0) != 0);
        return true;
      case 'assistant.transcription':
        _put(Speaker.manager, turn, m['text'] as String? ?? '', done: (m['turn_status'] as num? ?? 0) != 0);
        return true;
      case 'message.state':
        agentState = m['state'] as String?;
        return true;
      case 'message.interrupt':
        final c = _find(Speaker.manager, turn);
        if (c == null) return false;
        c
          ..done = true
          ..interrupted = true;
        _answer(c);
        return true;
      default:
        return false;
    }
  }

  void clear() {
    agentState = null;
    _heard.clear();
    _answered.clear();
    turns.clear();
    _chunks.clear();
  }

  void _put(Speaker speaker, int turn, String text, {required bool done}) {
    final c = _find(speaker, turn);
    if (c == null) {
      turns.add(Caption(speaker, turn, text, done: done));
      if (turns.length > keep) turns.removeAt(0);
    } else if (!c.interrupted) {
      c
        ..text = text
        ..done = done;
    }
    if (speaker == Speaker.you && done && text.trim().isNotEmpty && _heard.add(turn)) onHeard?.call(text);
    if (speaker == Speaker.manager && done) _answer(_find(speaker, turn)!);
  }

  void _answer(Caption c) {
    if (c.text.trim().isNotEmpty && _answered.add(c.turn)) onAnswered?.call(c.text);
  }

  Caption? _find(Speaker speaker, int turn) {
    for (final c in turns.reversed) {
      if (c.speaker == speaker && c.turn == turn) return c;
    }
    return null;
  }

  Map<String, dynamic>? _assemble(String packet) {
    final parts = packet.split('|');
    if (parts.length != 4) {
      // Not chunked: a plain JSON message.
      try {
        final decoded = jsonDecode(packet);
        return decoded is Map<String, dynamic> ? decoded : null;
      } on FormatException {
        return null;
      }
    }
    final [id, index, total, data] = parts;
    final i = int.tryParse(index);
    final n = total == '???' ? null : int.tryParse(total);
    if (i == null || i < 1 || (n != null && (n < 1 || i > n))) return null;
    final got = _chunks.putIfAbsent(id, () => {})..[i] = data;
    if (n == null || got.length < n) return null;
    _chunks.remove(id);
    try {
      final joined = [for (var k = 1; k <= n; k++) got[k] ?? ''].join();
      final decoded = jsonDecode(utf8.decode(base64.decode(joined)));
      return decoded is Map<String, dynamic> ? decoded : null;
    } on FormatException {
      return null;
    }
  }
}
