// The window's title bar in the desktop app (web/src/ui/DesktopTitleBar.tsx), drawn in the farm's colours: the app
// hides the system's (its traffic lights stay, on this bar), so the window is the game from top to bottom. Dragging
// it moves the window (the Swift side does that natively). Its height and title are desktopProvider's; elsewhere
// there is none.

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/theme.dart';
import '../desktop/desktop.dart';

class DesktopTitleBar extends ConsumerWidget {
  const DesktopTitleBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final desktop = ref.watch(desktopProvider);
    if (!desktop.isDesktop || desktop.titleBarHeight <= 0) return const SizedBox.shrink();
    return Container(
      height: desktop.titleBarHeight,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: Color(0xFF2F1F13),
        border: Border(bottom: BorderSide(color: Color(0xFF1A120B), width: 2)),
      ),
      child: Text(
        desktop.title,
        style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Color(0xFFE8D5A8)),
      ),
    );
  }
}
