// Which farm the app uses: the one on this machine (the desktop app starts it inside itself; elsewhere VIBEVALLEY_SERVER
// or http://127.0.0.1:8787), or another machine's, through its yard gate (院门, server/internal/channels/lan.go) with this
// device's key. The choice and the last other farm survive a restart (shared_preferences 'vibevalley.farm'); changing the
// choice rebuilds the whole app on the new farm (main.dart). A device finds the other farm by scanning the code its
// owner shows, or pasting its link; when that farm's address changed, scanning again keeps the key it has.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../gen/vibevalley.dart';

/// Another machine's farm, as this device was let in to it.
class RemoteFarm {
  const RemoteFarm({required this.url, required this.key, required this.farm, required this.device});

  /// The gate's address: `http://<address>:<port>`.
  final Uri url;
  final String key;

  /// The farm's name (its machine's) and this device's id there.
  final String farm;
  final String device;

  RemoteFarm at(Uri url) => RemoteFarm(url: url, key: key, farm: farm, device: device);

  Map<String, Object?> toJson() => {'url': '$url', 'key': key, 'farm': farm, 'device': device};

  static RemoteFarm? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final url = raw['url'], key = raw['key'], farm = raw['farm'], device = raw['device'];
    if (url is! String || key is! String || farm is! String || device is! String) return null;
    final parsed = Uri.tryParse(url);
    return parsed == null ? null : RemoteFarm(url: parsed, key: key, farm: farm, device: device);
  }
}

/// The farm the app uses, and the other farm it was last let in to (kept when it goes back to its own).
@immutable
class FarmChoice {
  const FarmChoice({this.remote, this.useRemote = false});
  final RemoteFarm? remote;
  final bool useRemote;

  /// The other farm when the app uses it; null: this machine's.
  RemoteFarm? get using => useRemote ? remote : null;
}

const _key = 'vibevalley.farm';

/// The choice, read before the first frame (loadFarmChoice); main.dart rebuilds the app when it changes.
final farmChoice = ValueNotifier<FarmChoice>(const FarmChoice());

Future<void> loadFarmChoice() async {
  try {
    final raw = (await SharedPreferences.getInstance()).getString(_key);
    if (raw == null) return;
    final json = jsonDecode(raw);
    if (json is! Map) return;
    final remote = RemoteFarm.fromJson(json['remote']);
    farmChoice.value = FarmChoice(remote: remote, useRemote: remote != null && json['use'] == 'remote');
  } on Object {
    // No storage, or a choice that does not read: this machine's farm.
  }
}

Future<void> saveFarmChoice(FarmChoice choice) async {
  farmChoice.value = choice;
  try {
    await (await SharedPreferences.getInstance()).setString(
      _key,
      jsonEncode({'use': choice.useRemote ? 'remote' : 'local', 'remote': choice.remote?.toJson()}),
    );
  } on Object {
    // No storage: the choice lasts for this run.
  }
}

/// What a pairing code travels in (lan.go lanPairLink): `vibevalley://pair?u=<the gate's address>&c=<code>`.
class PairLink {
  const PairLink(this.url, this.code);
  final Uri url;
  final String code;

  /// The link in a scanned code or pasted text (spaces around it allowed); null when it is not one.
  static PairLink? parse(String text) {
    final link = Uri.tryParse(text.trim());
    if (link == null || link.scheme != 'vibevalley' || link.host != 'pair') return null;
    final url = Uri.tryParse(link.queryParameters['u'] ?? '');
    final code = link.queryParameters['c'] ?? '';
    if (url == null || !url.isScheme('http') || url.host.isEmpty || code.isEmpty) return null;
    return PairLink(url, code);
  }
}

/// The name this device asks with, as the other farm's owner sees it.
String deviceName() {
  var host = '';
  try {
    host = Platform.localHostname.replaceAll(RegExp(r'\.local$'), '');
  } on Object {
    // No name to read.
  }
  if (host.isNotEmpty && host != 'localhost') return host;
  if (Platform.isIOS) return 'iPhone';
  if (Platform.isAndroid) return '安卓手机';
  if (Platform.isMacOS) return 'Mac';
  return '一台设备';
}

/// A client for a farm at `url`, with this device's key when it has one; tests give a fake.
typedef ApiFor = VibeValleyApi Function(Uri url, String? key);

/// Gets into the farm a link points to. With a key for it already (the address changed, scanned again), the key is
/// tried first and kept; otherwise the device asks with the code and waits until that farm's owner answers. Throws
/// the farm's reason when it is refused.
Future<RemoteFarm> pairWith(PairLink link, {required String name, RemoteFarm? known, required ApiFor apiFor}) async {
  if (known != null) {
    final api = apiFor(link.url, known.key);
    try {
      final me = await api.lan.me();
      return RemoteFarm(url: link.url, key: known.key, farm: known.farm, device: me.id);
    } on Object {
      // Not a key this farm knows (or no answer): ask with the code.
    } finally {
      api.close();
    }
  }
  final api = apiFor(link.url, null);
  try {
    final paired = await api.lan.pair(
      body: LanPairRequest(code: link.code, name: name),
    );
    return RemoteFarm(url: link.url, key: paired.key, farm: paired.farm, device: paired.device);
  } on http.ClientException {
    throw VibeValleyApiError(0, null, '连不上 ${link.url.host}：两台设备要在同一个网络里，那台电脑的院门要开着');
  } finally {
    api.close();
  }
}
