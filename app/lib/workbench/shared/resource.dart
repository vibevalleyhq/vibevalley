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

  Future<void> refresh() async {
    if (loading) return;
    loading = true;
    error = null;
    _notify();
    try {
      value = await fetch();
    } on Object catch (e) {
      error = reasonOf(e);
    } finally {
      loading = false;
      _notify();
    }
  }

  void put(T next) {
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
