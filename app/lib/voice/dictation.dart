// One recording attempt owns its recorder, temporary file and original input target through transcription or cancellation.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../gen/vibevalley.dart';

enum DictationPhase { idle, recording, transcribing }

class DictationTarget {
  DictationTarget(this._onWords);
  final void Function(String) _onWords;
  bool _alive = true;
  VoidCallback? _cancel;

  void dispose() {
    _alive = false;
    _cancel?.call();
    _cancel = null;
  }
}

class _Cancelled implements Exception {}

class _Attempt {
  _Attempt(this.recorder, this.target);
  final AudioRecorder recorder;
  final DictationTarget target;
  final cancelled = Completer<void>();
  late Future<void> starting;
  Future<void>? finishing;
  Future<void>? cleaning;
  String? path;

  bool get stopped => cancelled.isCompleted;
  void check() {
    if (stopped) throw _Cancelled();
  }

  Future<void> cleanup() => cleaning ??= _cleanup();
  Future<void> _cleanup() async {
    try {
      await recorder.cancel();
    } on Object catch (e) {
      debugPrint('vibevalley: dictation cancel: $e');
    }
    try {
      await recorder.dispose();
    } on Object catch (e) {
      debugPrint('vibevalley: dictation release: $e');
    }
    final file = path;
    path = null;
    if (file != null) {
      try {
        await File(file).delete();
      } on Object catch (e) {
        debugPrint('vibevalley: dictation file cleanup: $e');
      }
    }
  }
}

class Dictation extends ChangeNotifier {
  Dictation(this.api, {AudioRecorder Function()? recorder}) : _make = recorder ?? AudioRecorder.new;
  final VibeValleyApi api;
  final AudioRecorder Function() _make;
  _Attempt? _attempt;
  bool _disposed = false;
  DictationPhase phase = DictationPhase.idle;
  String? problem;

  static const _config = RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1);

  Future<void> toggle(DictationTarget target) {
    if (_disposed || !target._alive) return Future.value();
    final attempt = _attempt;
    if (attempt == null) {
      final AudioRecorder recorder;
      try {
        recorder = _make();
      } on Object catch (e) {
        _set(DictationPhase.idle, problem: '录不了音：$e');
        return Future.value();
      }
      final next = _Attempt(recorder, target);
      _attempt = next;
      next.starting = _start(next);
      target._cancel = () {
        if (!next.stopped) next.cancelled.complete();
        // Targets detach during widget disposal; invalidate now and publish the phase after that frame.
        scheduleMicrotask(() {
          if (identical(_attempt, next)) unawaited(_cancel(next));
        });
      };
      _set(DictationPhase.recording, problem: null);
      return next.starting;
    }
    if (phase == DictationPhase.transcribing) return Future.value();
    // A second button may stop the recording, but cannot replace the first button's target.
    return attempt.finishing ??= _finish(attempt);
  }

  Future<void> _start(_Attempt attempt) async {
    try {
      if (!await attempt.recorder.hasPermission()) throw StateError('没有麦克风权限');
      attempt.check();
      attempt.path = '${Directory.systemTemp.path}/vibevalley-dictation-${DateTime.now().microsecondsSinceEpoch}.wav';
      await attempt.recorder.start(_config, path: attempt.path!);
      attempt.check();
    } on Object catch (e) {
      if (!attempt.stopped) problem = '录不了音：${e is StateError ? e.message : e}';
      if (!attempt.stopped) attempt.cancelled.complete();
      await attempt.cleanup();
      _retire(attempt);
    }
  }

  Future<void> _finish(_Attempt attempt) async {
    _set(DictationPhase.transcribing);
    try {
      await attempt.starting;
      attempt.check();
      attempt.path = await attempt.recorder.stop() ?? attempt.path;
      attempt.check();
      final path = attempt.path;
      if (path == null) throw StateError('没录上');
      final audio = await File(path).readAsBytes();
      attempt.check();
      final said = await Future.any([
        api.voice.dictate(
          body: DictateRequest(audio: base64Encode(audio), format: 'wav'),
        ),
        attempt.cancelled.future.then<Dictated>((_) => throw _Cancelled()),
      ]);
      attempt.check();
      if (attempt.target._alive && said.text.isNotEmpty) attempt.target._onWords(said.text);
    } on Object catch (e) {
      if (!attempt.stopped) problem = e is StateError ? e.message : '$e';
    } finally {
      await attempt.cleanup();
      _retire(attempt);
    }
  }

  Future<void> _cancel(_Attempt attempt) async {
    if (!attempt.stopped) attempt.cancelled.complete();
    _set(DictationPhase.transcribing);
    await attempt.starting;
    final finishing = attempt.finishing;
    if (finishing != null) await finishing;
    await attempt.cleanup();
    _retire(attempt);
  }

  void _retire(_Attempt attempt) {
    if (!identical(_attempt, attempt)) return;
    attempt.target._cancel = null;
    _attempt = null;
    _set(DictationPhase.idle);
  }

  static const _keep = Object();
  void _set(DictationPhase next, {Object? problem = _keep}) {
    if (_disposed) return;
    phase = next;
    if (problem != _keep) this.problem = problem as String?;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    final attempt = _attempt;
    if (attempt != null) unawaited(_cancel(attempt));
    super.dispose();
  }
}
