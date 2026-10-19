import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app/app.dart';
import 'data/server_choice.dart';
import 'host/desktop.dart';
import 'host/mobile_notices.dart';
import 'ui/kit/kit.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await loadServerChoice();
  await startDesktop();
  await PhoneNotices.instance.start();
  kitOpenLink = (uri) => unawaited(launchUrl(uri));
  runApp(const OnChosenFarm());
}
