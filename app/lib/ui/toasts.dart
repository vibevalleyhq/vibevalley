import 'dart:async';
import 'package:flutter/widgets.dart';

// Each closes after its timeout (5 s by default), held while the pointer is over the stack; past three they hide.

abstract final class ToastType {
  static const info = 'info';
  static const warn = 'warn';
  static const error = 'error';
  static const achievement = 'achievement';
}

const noticeTitle = {ToastType.info: '提示', ToastType.warn: '没派成', ToastType.error: '出错了'};

class ToastData {
  ToastData._(this.id, this.type, this.title, this.description, this.timeout, this.data);
  final int id;
  final String type;
  final String title;
  final String? description;
  final Duration timeout;

  final Object? data;
}

class ToastManager extends ChangeNotifier {
  ToastManager({this.limit = 3});

  /// The rest wait hidden behind.
  final int limit;

  final _list = <ToastData>[];
  final _timers = <int, Timer>{};
  final _left = <int, Duration>{};
  final _started = <int, DateTime>{};
  var _next = 0;
  var _paused = false;

  List<ToastData> get toasts => List.unmodifiable(_list);

  int add({String type = ToastType.info, required String title, String? description, Duration timeout = const Duration(milliseconds: 5000), Object? data}) {
    final t = ToastData._(++_next, type, title, description, timeout, data);
    _list.insert(0, t);
    _left[t.id] = timeout;
    if (!_paused) _start(t.id);
    notifyListeners();
    return t.id;
  }

  void close(int id) {
    _timers.remove(id)?.cancel();
    _left.remove(id);
    _started.remove(id);
    final before = _list.length;
    _list.removeWhere((t) => t.id == id);
    if (_list.length != before) notifyListeners();
  }

  void _start(int id) {
    final left = _left[id];
    if (left == null || left <= Duration.zero) return;
    _started[id] = DateTime.now();
    _timers[id] = Timer(left, () => close(id));
  }

  void pause() {
    if (_paused) return;
    _paused = true;
    final now = DateTime.now();
    for (final MapEntry(:key, :value) in _timers.entries) {
      value.cancel();
      final started = _started[key];
      if (started != null) _left[key] = _left[key]! - now.difference(started);
    }
    _timers.clear();
  }

  void resume() {
    if (!_paused) return;
    _paused = false;
    for (final t in _list) {
      _start(t.id);
    }
  }

  @override
  void dispose() {
    for (final t in _timers.values) {
      t.cancel();
    }
    super.dispose();
  }
}

final toasts = ToastManager();
