import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'follow.dart';

/// Starts the single host follow before the app's pages build.
class DesktopHost extends ConsumerWidget {
  const DesktopHost({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(hostFollowProvider);
    return child;
  }
}
