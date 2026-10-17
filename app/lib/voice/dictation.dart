// Dictation: one stretch of speech becomes words for an input box. It is recorded here, sent whole once you stop
// (POST /api/v1/voice/dictate), and the farm passes it on to the transcription endpoint the owner set in 声音 → 听写.
// Nothing leaves while recording.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../gen/vibevalley.dart';

enum DictationPhase { idle, recording, transcribing }

class Dictation extends ChangeNotifier {
  Dictation(this.api, {AudioRecorder Function()? recorder}) : _make = recorder ?? AudioRecorder.new;

  final VibeValleyApi api;
  final AudioRecorder Function() _make;
  AudioRecorder? _recorder;
  String? _path;
  bool _disposed = false;

  DictationPhase phase = DictationPhase.idle;
  String? problem;

  // 16 kHz mono WAV: what transcription models take, so the endpoint does not resample.
  static const _config = RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1);

  Future<void> start() async {
    if (_disposed || phase != DictationPhase.idle) return;
    _set(DictationPhase.recording, problem: null);
    try {
      final recorder = _recorder ??= _make();
      if (!await recorder.hasPermission()) throw StateError('没有麦克风权限');
      final path = '${Directory.systemTemp.path}/vibevalley-dictation-${DateTime.now().microsecondsSinceEpoch}.wav';
      _path = path;
      await recorder.start(_config, path: path);
    } on Object catch (e) {
      _set(DictationPhase.idle, problem: '录不了音：${e is StateError ? e.message : e}');
    }
  }

  /// The words, or null when nothing came of it (`problem` says why).
  Future<String?> stop() async {
    if (_disposed || phase != DictationPhase.recording) return null;
    _set(DictationPhase.transcribing);
    final recorder = _recorder!;
    File? file;
    try {
      final path = await recorder.stop() ?? _path;
      if (path == null) throw StateError('没录上');
      file = File(path);
      final audio = await file.readAsBytes();
      final said = await api.voice.dictate(
        body: DictateRequest(audio: base64Encode(audio), format: 'wav'),
      );
      _set(DictationPhase.idle);
      return said.text;
    } on Object catch (e) {
      _set(DictationPhase.idle, problem: e is StateError ? e.message : '$e');
      return null;
    } finally {
      _path = null;
      file?.delete().ignore();
    }
  }

  Future<void> toggle(void Function(String text) onWords) async {
    switch (phase) {
      case DictationPhase.idle:
        await start();
      case DictationPhase.recording:
        final text = await stop();
        if (text != null && text.isNotEmpty) onWords(text);
      case DictationPhase.transcribing:
        return;
    }
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
    final recorder = _recorder;
    _recorder = null;
    if (recorder != null) recorder.cancel().whenComplete(recorder.dispose).ignore();
    super.dispose();
  }
}
