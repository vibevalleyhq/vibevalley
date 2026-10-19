import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../gen/vibevalley.dart';
import 'server.dart';

class RemoteServer {
  const RemoteServer({required this.url, required this.key, required this.hostName, required this.device});

  final Uri url;
  final String key;

  final String hostName;
  final String device;

  RemoteServer at(Uri url) => RemoteServer(url: url, key: key, hostName: hostName, device: device);

  Map<String, Object?> toJson() => {'url': '$url', 'key': key, 'hostName': hostName, 'device': device};

  static RemoteServer? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final url = raw['url'], key = raw['key'], hostName = raw['hostName'], device = raw['device'];
    if (url is! String || key is! String || hostName is! String || device is! String) return null;
    final parsed = Uri.tryParse(url);
    return parsed == null ? null : RemoteServer(url: parsed, key: key, hostName: hostName, device: device);
  }
}

@immutable
class ServerChoice {
  const ServerChoice({this.remote, this.useRemote = false});
  final RemoteServer? remote;
  final bool useRemote;

  RemoteServer? get using => useRemote ? remote : null;
}

const _key = 'vibevalley.server';

/// The destination and the server it opens: one place for local/remote, the embedded address and the scope key.
class ServerConnection {
  const ServerConnection({required this.choice, this.localAddress});
  final ServerChoice choice;
  final String? localAddress;

  RemoteServer? get remote => choice.using;
  ServerConnection withLocal(String address) => ServerConnection(choice: choice, localAddress: address);
  VibeValleyServer open(String fallback) =>
      remote != null ? VibeValleyServer(remote!.url, key: remote!.key) : VibeValleyServer(Uri.parse(localAddress ?? fallback));

  /// Anything that changes here must rebuild the ProviderScope.
  String get scopeKey => remote == null ? 'local:${localAddress ?? ''}' : 'remote:${remote!.url} ${remote!.device} ${remote!.key}';
}

final serverConnection = ValueNotifier<ServerConnection>(const ServerConnection(choice: ServerChoice()));

Future<void> loadServerChoice() async {
  try {
    final raw = (await SharedPreferences.getInstance()).getString(_key);
    if (raw == null) return;
    final json = jsonDecode(raw);
    if (json is! Map) return;
    final remote = RemoteServer.fromJson(json['remote']);
    serverConnection.value = ServerConnection(
      choice: ServerChoice(remote: remote, useRemote: remote != null && json['use'] == 'remote'),
      localAddress: serverConnection.value.localAddress,
    );
  } on Object {
    // No storage, or a choice that does not read: this machine's farm.
  }
}

Future<void> saveServerChoice(ServerChoice choice) async {
  serverConnection.value = ServerConnection(choice: choice, localAddress: serverConnection.value.localAddress);
  try {
    await (await SharedPreferences.getInstance()).setString(
      _key,
      jsonEncode({'use': choice.useRemote ? 'remote' : 'local', 'remote': choice.remote?.toJson()}),
    );
  } on Object {
    // No storage: the choice lasts for this run.
  }
}

/// `vibevalley://pair?u=<the lan listener's address>&c=<code>` (lan.go lanPairLink).
class PairLink {
  const PairLink(this.url, this.code);
  final Uri url;
  final String code;

  /// Spaces around it allowed.
  static PairLink? parse(String text) {
    final link = Uri.tryParse(text.trim());
    if (link == null || link.scheme != 'vibevalley' || link.host != 'pair') return null;
    final url = Uri.tryParse(link.queryParameters['u'] ?? '');
    final code = link.queryParameters['c'] ?? '';
    if (url == null || !url.isScheme('http') || url.host.isEmpty || code.isEmpty) return null;
    return PairLink(url, code);
  }
}

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

typedef ApiFor = VibeValleyApi Function(Uri url, String? key);

/// With a key for it already (the address changed, scanned again), the key is tried first and kept; otherwise the device asks with the code.
Future<RemoteServer> pairWith(PairLink link, {required String name, RemoteServer? known, required ApiFor apiFor}) async {
  if (known != null) {
    final api = apiFor(link.url, known.key);
    try {
      final me = await api.lan.me();
      return RemoteServer(url: link.url, key: known.key, hostName: known.hostName, device: me.id);
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
    return RemoteServer(url: link.url, key: paired.key, hostName: paired.hostName, device: paired.device);
  } on http.ClientException {
    throw VibeValleyApiError(0, null, '连不上 ${link.url.host}：两台设备要在同一个网络里，那台电脑要允许连接');
  } finally {
    api.close();
  }
}
