import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'command.dart';
import 'notify.dart';

bool get isPhone => !kIsWeb && (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android);

/// 0 is not allowed for a foreground service's notification.
const _linkId = 1;

const _farmChannel = AndroidNotificationDetails('farm', '农场', channelDescription: '帮工做完活、没做成、叫你的时候', importance: Importance.high, priority: Priority.high);

const _linkChannel = AndroidNotificationDetails(
  'link',
  '连着农场',
  channelDescription: 'VibeValley 在后台连着农场，好在帮工做完活时通知你',
  importance: Importance.low,
  priority: Priority.low,
  ongoing: true,
  showWhen: false,
);

class PhoneNotices {
  PhoneNotices._();
  static final instance = PhoneNotices._();

  final _plugin = FlutterLocalNotificationsPlugin();
  late final _commands = StreamController<HostCommand>.broadcast(onListen: _flush);

  /// Held until a screen listens.
  HostCommand? _pending;
  bool _ready = false;
  bool _linked = false;
  AppLifecycleListener? _lifecycle;
  int _next = 100;

  Stream<HostCommand> get commands => _commands.stream;

  Future<void> start() async {
    if (!isPhone || _ready) return;
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher'), iOS: DarwinInitializationSettings()),
        onDidReceiveNotificationResponse: (r) => open(r.payload),
      );
      await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      final launch = await _plugin.getNotificationAppLaunchDetails();
      if (launch?.didNotificationLaunchApp ?? false) open(launch!.notificationResponse?.payload);
      _ready = true;
      _lifecycle ??= AppLifecycleListener(onPause: () => unawaited(_keepLinked(true)), onResume: () => unawaited(_keepLinked(false)));
    } on Object catch (e) {
      debugPrint('vibevalley: notifications: $e');
    }
  }

  @visibleForTesting
  void open(String? payload) {
    if (payload == null || payload.isEmpty) return;
    HostCommand? command;
    try {
      command = HostCommand.fromJson(jsonDecode(payload));
    } on Object {
      return;
    }
    if (command == null) return;
    if (_commands.hasListener) {
      _commands.add(command);
    } else {
      _pending = command;
    }
  }

  void _flush() {
    final held = _pending;
    _pending = null;
    if (held != null) scheduleMicrotask(() => _commands.add(held));
  }

  Future<void> show(HostNotice notice) async {
    if (!_ready) return;
    try {
      await _plugin.show(
        id: _next++,
        title: notice.title,
        body: notice.body,
        notificationDetails: const NotificationDetails(android: _farmChannel, iOS: DarwinNotificationDetails()),
        payload: notice.open == null ? null : jsonEncode(notice.open!.toJson()),
      );
    } on Object catch (e) {
      debugPrint('vibevalley: notify: $e');
    }
  }

  Future<void> _keepLinked(bool on) async {
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (!_ready || android == null || on == _linked) return;
    _linked = on;
    try {
      if (on) {
        await android.startForegroundService(
          id: _linkId,
          title: 'VibeValley 连着农场',
          body: '帮工做完活、叫你的时候会通知你',
          notificationDetails: _linkChannel,
          foregroundServiceTypes: {AndroidServiceForegroundType.foregroundServiceTypeRemoteMessaging},
        );
      } else {
        await android.stopForegroundService();
      }
    } on Object catch (e) {
      debugPrint('vibevalley: foreground service: $e');
    }
  }
}
