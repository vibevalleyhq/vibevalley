import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app/router.dart';
import 'desk/places.dart';
import 'data/farm_choice.dart';
import 'desktop/desktop.dart';
import 'mobile/notices.dart';
import 'shell/app_frame.dart';
import 'ui/kit/kit.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await loadFarmChoice();
  await startDesktop();
  await PhoneNotices.instance.start();
  kitOpenLink = (uri) => unawaited(launchUrl(uri));
  runApp(const _OnChosenFarm());
}

class _OnChosenFarm extends StatelessWidget {
  const _OnChosenFarm();

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
