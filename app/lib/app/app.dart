import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/farm_choice.dart';
import '../desk/places.dart';
import '../host/desktop.dart';
import '../shell/app_frame.dart';
import '../ui/kit/kit.dart';
import 'router.dart';

// The root the app runs: the chosen farm, its provider scope and the frame around every page.

class OnChosenFarm extends StatelessWidget {
  const OnChosenFarm({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<FarmChoice>(
    valueListenable: farmChoice,
    builder: (_, choice, _) => ProviderScope(
      key: ValueKey(choice.using == null ? 'local' : '${choice.using!.url} ${choice.using!.device} ${choice.using!.key}'),
      child: const DesktopHost(child: VibeValleyApp()),
    ),
  );
}

bool _onFarm() => Place.of(router.routerDelegate.currentConfiguration.uri.path) == null;

class VibeValleyApp extends StatelessWidget {
  const VibeValleyApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp.router(
    title: '码农场物语',
    theme: farmTheme(),
    routerConfig: router,
    debugShowCheckedModeBanner: false,
    builder: (context, child) => AppFrame(onFarm: _onFarm, routeChanges: router.routerDelegate, child: child ?? const SizedBox.shrink()),
  );
}
