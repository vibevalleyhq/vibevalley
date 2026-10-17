import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import './command.dart';
import './notify.dart';

bool get isPhone => !kIsWeb && (Platform.isIOS || Platform.isAndroid);

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

  Future<void> keepLinked(bool on) async {
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

final phoneFollowProvider = Provider<void>((ref) {
  if (!isPhone) return;
  final notices = PhoneNotices.instance;
  final bell = CallBell();
  bool away() => WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed;
  void tell(HostNotice? notice) {
    if (notice != null && away()) unawaited(notices.show(notice));
  }

  ref.listen(stateFrameProvider, (_, next) {
    final frame = next.value;
    if (frame == null) return;
    // A call seen on the screen is not notified later.
    for (final call in bell.ring(frame.frame.inbox)) {
      tell(noticeForCall(call));
    }
  });
  ref.listen(effectsProvider, (_, next) => tell(next.value == null ? null : noticeForEffect(next.value!)));
  ref.listen(sideEventsProvider, (_, next) => tell(next.value == null ? null : noticeForEvent(next.value!)));
  final lifecycle = AppLifecycleListener(onPause: () => unawaited(notices.keepLinked(true)), onResume: () => unawaited(notices.keepLinked(false)));
  ref.onDispose(lifecycle.dispose);
});
