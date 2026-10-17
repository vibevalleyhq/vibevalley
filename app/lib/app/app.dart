import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/farm_choice.dart';
import '../workbench/places.dart';
import '../host/host.dart';
import '../shell/app_frame.dart';
import '../ui/kit/kit.dart';
import 'host_router.dart';
import 'router.dart';

// The root the app runs: the chosen farm, its provider scope and the frame around every page.

class OnChosenFarm extends StatelessWidget {
  const OnChosenFarm({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<FarmConnection>(
    valueListenable: farmConnection,
    builder: (_, connection, _) => ProviderScope(
      key: ValueKey(connection.scopeKey),
      child: const DesktopHost(child: VibeValleyApp()),
    ),
  );
}

bool _onFarm() => Place.of(router.routerDelegate.currentConfiguration.uri.path) == null;

class VibeValleyApp extends ConsumerWidget {
  const VibeValleyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(hostCommandRouterProvider);
    return MaterialApp.router(
      title: '码农场物语',
      theme: farmTheme(),
      routerConfig: router,
      debugShowCheckedModeBanner: false,
      builder: (context, child) => AppFrame(onFarm: _onFarm, routeChanges: router.routerDelegate, child: child ?? const SizedBox.shrink()),
    );
  }
}
