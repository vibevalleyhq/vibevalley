// One follow of the farm, two ways of reaching the owner: the desktop's tray and native notices, the phone's local
// notices and foreground service. The subscriptions, CallBell and notice decisions live here once.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import 'desktop.dart' show DesktopHostChannel, hostProvider;
import 'mobile_notices.dart' show PhoneNotices, isPhone;
import 'notify.dart';

class HostDelivery {
  const HostDelivery({required this.notify, this.tray, this.canNotify, this.keepLinked});

  final Future<void> Function(HostNotice) notify;
  final Future<void> Function(TraySummary)? tray;
  final bool Function()? canNotify;
  final Future<void> Function(bool)? keepLinked;
}

final hostDeliveryProvider = Provider<HostDelivery?>((ref) {
  final host = ref.watch(hostProvider);
  if (host.isDesktop) {
    return HostDelivery(notify: DesktopHostChannel.instance.notify, tray: DesktopHostChannel.instance.tray);
  }
  if (isPhone) {
    return HostDelivery(
      notify: PhoneNotices.instance.show,
      canNotify: () => WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed,
      keepLinked: PhoneNotices.instance.keepLinked,
    );
  }
  return null;
});

final hostFollowProvider = Provider<void>((ref) {
  final delivery = ref.watch(hostDeliveryProvider);
  if (delivery == null) return;
  final follow = HostFollow(ref, delivery);
  ref.onDispose(follow.dispose);
});

class HostFollow {
  HostFollow(this.ref, this.delivery) {
    final tray = delivery.tray;
    if (tray != null) {
      _shown = TraySummary.opening;
      unawaited(tray(_shown!));
    }
    ref.listen(stateFrameProvider, (_, next) {
      final frame = next.value;
      if (frame == null) return;
      final summary = traySummary(frame.state, frame.frame.inbox);
      if (summary != _shown) {
        _shown = summary;
        if (tray != null) unawaited(tray(summary));
      }
      for (final call in _bell.ring(frame.frame.inbox)) {
        _tell(noticeForCall(call));
      }
    });
    ref.listen(effectsProvider, (_, next) => _tell(next.value == null ? null : noticeForEffect(next.value!)));
    ref.listen(sideEventsProvider, (_, next) => _tell(next.value == null ? null : noticeForEvent(next.value!)));
    final keep = delivery.keepLinked;
    if (keep != null) {
      _lifecycle = AppLifecycleListener(onPause: () => unawaited(keep(true)), onResume: () => unawaited(keep(false)));
    }
  }

  final Ref ref;
  final HostDelivery delivery;
  final _bell = CallBell();
  TraySummary? _shown;
  AppLifecycleListener? _lifecycle;

  void _tell(HostNotice? notice) {
    if (notice == null || delivery.canNotify?.call() == false) return;
    unawaited(delivery.notify(notice));
  }

  void dispose() => _lifecycle?.dispose();
}
