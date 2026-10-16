// The frame around every screen (web/src/App.tsx): the desktop app's title bar on top; under it the route's screen,
// and over that the title screen (on the farm only, when the app opens), the toasts, the server-away banner, the
// debug console (` toggles it) and, until everything has loaded, startup. main.dart puts it around the router's
// child (MaterialApp.router's builder).
//
// Stacked as the web page's z-indexes have them: the debug console (40) under the toasts (50), under the title screen
// and the server banner (60); startup (95) over all of it but the title bar, which stays to drag the window by.

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../ui/kit/kit.dart';
import 'debug/debug_log.dart';
import 'debug/debug_panel.dart';
import 'desktop_title_bar.dart';
import 'fx_layer.dart';
import 'server_away.dart';
import 'title/startup.dart';
import 'title/title_screen.dart';
import 'title/title_state.dart';

class AppFrame extends ConsumerStatefulWidget {
  const AppFrame({super.key, required this.child, required this.onFarm, this.routeChanges, this.startup = true});

  /// The route's screen.
  final Widget child;

  /// Whether the route shown is the farm itself (the title screen comes over the farm only; the desk goes without).
  final bool Function() onFarm;

  /// Fires when the route changes (the router's delegate), to ask `onFarm` again.
  final Listenable? routeChanges;

  /// Whether to show startup's loading screen (tests leave it out).
  final bool startup;

  @override
  ConsumerState<AppFrame> createState() => _AppFrameState();
}

class _AppFrameState extends ConsumerState<AppFrame> {
  @override
  void initState() {
    super.initState();
    widget.routeChanges?.addListener(_routed);
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void didUpdateWidget(AppFrame old) {
    super.didUpdateWidget(old);
    if (old.routeChanges != widget.routeChanges) {
      old.routeChanges?.removeListener(_routed);
      widget.routeChanges?.addListener(_routed);
    }
  }

  @override
  void dispose() {
    widget.routeChanges?.removeListener(_routed);
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
  }

  /// The route changed. The router can say so while the tree is building (its first route): rebuild after that frame.
  void _routed() {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
      return;
    }
    setState(() {});
  }

  bool _onKey(KeyEvent e) => debugHotkey(e, ref.read(debugOpenProvider.notifier).toggle);

  @override
  Widget build(BuildContext context) {
    // The console's log runs from the start, open or not.
    ref.listen(debugLogProvider, (_, _) {});
    final title = ref.watch(titleOpenProvider) && widget.onFarm();
    final atlas = ref.watch(atlasProvider).value;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const DesktopTitleBar(),
        Expanded(
          child: Stack(
            fit: StackFit.expand,
            children: [
              widget.child,
              // Above the router's navigator: an overlay and a material of their own, for the text fields and tooltips.
              Material(
                type: MaterialType.transparency,
                child: Overlay.wrap(
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      const DebugPanel(),
                      ToastViewport(leading: toastLeading(atlas), kicker: toastKicker),
                      if (title) const TitleScreen(),
                      const ServerAway(),
                      if (widget.startup) const Startup(),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
