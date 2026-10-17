import 'package:flutter/foundation.dart';

import '../../data/remote.dart' show reasonOf;

/// A page's one async value: loading, ready or failed, with the server's reason kept. Pages own the fetch and the layout.
class WorkbenchResource<T> extends ChangeNotifier {
  WorkbenchResource(this.fetch);
  final Future<T> Function() fetch;

  T? value;
  String? error;
  bool loading = false;
  bool _disposed = false;
  int _revision = 0;

  Future<void> refresh() async {
    if (loading || _disposed) return;
    final revision = _revision;
    loading = true;
    error = null;
    _notify();
    try {
      final next = await fetch();
      if (!_disposed && revision == _revision) value = next;
    } on Object catch (e) {
      if (!_disposed && revision == _revision) error = reasonOf(e);
    } finally {
      loading = false;
      _notify();
    }
  }

  void put(T next) {
    if (_disposed) return;
    _revision++;
    value = next;
    error = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
