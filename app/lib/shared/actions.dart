import '../data/remote.dart';
import '../ui/toasts.dart';

/// A command whose failure the owner hears about as a toast; null when it failed.
Future<T?> runAction<T>(Future<T> Function() command) async {
  try {
    return await command();
  } on Object catch (e) {
    toasts.add(type: ToastType.error, title: '出错了', description: reasonOf(e));
    return null;
  }
}
