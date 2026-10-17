import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/farm_choice.dart';
import 'package:vibevalley/desk/gate/gate_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/server.dart' show jsonResponse, settle;
import 'package:vibevalley/data/providers.dart';

const _gate = 'http://192.168.1.5:8790';

void main() {
  group('PairLink', () {
    test('reads the link a gate gives, spaces around it allowed', () {
      final link = PairLink.parse('  vibevalley://pair?u=${Uri.encodeQueryComponent(_gate)}&c=ABC234 \n');
      expect(link?.url, Uri.parse(_gate));
      expect(link?.code, 'ABC234');
    });

    test('is nothing else', () {
      for (final text in [
        '',
        'hello',
        'https://pair?u=http://a&c=1',
        'vibevalley://pair?u=http://a',
        'vibevalley://pair?c=1',
        'vibevalley://other?u=http://a&c=1',
        'vibevalley://pair?u=ftp://a&c=1',
      ]) {
        expect(PairLink.parse(text), isNull, reason: text);
      }
    });
  });

  test('the choice survives a restart, and the other farm is kept when going back', () async {
    SharedPreferences.setMockInitialValues({});
    final remote = RemoteFarm(url: Uri.parse(_gate), key: 'k1', farm: 'lucas-mbp', device: 'd1');
    await saveFarmChoice(FarmChoice(remote: remote, useRemote: true));
    farmChoice.value = const FarmChoice();
    await loadFarmChoice();
    expect(farmChoice.value.using?.url, Uri.parse(_gate));
    expect(farmChoice.value.using?.key, 'k1');

    await saveFarmChoice(FarmChoice(remote: remote));
    farmChoice.value = const FarmChoice();
    await loadFarmChoice();
    expect(farmChoice.value.using, isNull);
    expect(farmChoice.value.remote?.farm, 'lucas-mbp');
    farmChoice.value = const FarmChoice();
  });

  group('pairWith', () {
    final link = PairLink(Uri.parse(_gate), 'ABC234');

    (ApiFor, List<String>) farm({Set<String> known = const {}, bool allow = true}) {
      final calls = <String>[];
      VibeValleyApi apiFor(Uri url, String? key) => VibeValleyApi(
        url,
        MockClient((r) async {
          calls.add('${r.method} ${r.url.path} ${key ?? '-'}');
          switch ((r.method, r.url.path)) {
            case ('GET', '/api/v1/gate/me'):
              return known.contains(key)
                  ? jsonResponse(const LanDevice(id: 'd1', name: 'iPhone', pairedAt: 1).toJson())
                  : jsonResponse({'_tag': 'LanRefused', 'reason': '没配对'}, 401);
            case ('POST', '/api/v1/gate/pair'):
              final body = LanPairRequest.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
              expect(body.code, 'ABC234');
              return allow
                  ? jsonResponse(const LanPaired(device: 'd2', key: 'new-key', farm: 'lucas-mbp').toJson())
                  : jsonResponse({'_tag': 'LanRefused', 'reason': '主人没让这台设备进来'}, 403);
          }
          return jsonResponse({'_tag': 'Missing', 'what': r.url.path}, 404);
        }),
      );
      return (apiFor, calls);
    }

    test('asks with the code and gets a key', () async {
      final (apiFor, calls) = farm();
      final got = await pairWith(link, name: 'iPhone', apiFor: apiFor);
      expect((got.url, got.key, got.farm, got.device), (Uri.parse(_gate), 'new-key', 'lucas-mbp', 'd2'));
      expect(calls, ['POST /api/v1/gate/pair -']);
    });

    test('keeps a key the farm still knows, at its new address', () async {
      final (apiFor, calls) = farm(known: {'old-key'});
      final known = RemoteFarm(url: Uri.parse('http://10.0.0.2:8790'), key: 'old-key', farm: 'lucas-mbp', device: 'd1');
      final got = await pairWith(link, name: 'iPhone', known: known, apiFor: apiFor);
      expect((got.url, got.key), (Uri.parse(_gate), 'old-key'));
      expect(calls, ['GET /api/v1/gate/me old-key']);
    });

    test('asks again when the farm forgot the key, and says why it is refused', () async {
      final (apiFor, calls) = farm(allow: false);
      final known = RemoteFarm(url: Uri.parse(_gate), key: 'old-key', farm: 'x', device: 'd1');
      await expectLater(
        pairWith(link, name: 'iPhone', known: known, apiFor: apiFor),
        throwsA(isA<VibeValleyApiError>().having((e) => e.reason, 'reason', '主人没让这台设备进来')),
      );
      expect(calls, ['GET /api/v1/gate/me old-key', 'POST /api/v1/gate/pair -']);
    });
  });

  group('the page', () {
    late LanStatus status;
    late List<String> writes;

    VibeValleyApi server() => VibeValleyApi(
      Uri.parse('http://farm.test'),
      MockClient((r) async {
        if (r.method != 'GET') writes.add('${r.method} ${r.url.path} ${r.body}');
        switch ((r.method, r.url.path)) {
          case ('GET', '/api/v1/gate'):
            break;
          case ('PUT', '/api/v1/gate'):
            final open = (jsonDecode(r.body) as Map)['open'] as bool;
            status = LanStatus(open: open, farm: 'lucas-mbp', url: open ? _gate : null, devices: status.devices);
          case ('POST', '/api/v1/gate/pairing/answer'):
            status = LanStatus(
              open: true,
              farm: 'lucas-mbp',
              url: _gate,
              devices: [
                ...status.devices,
                const LanDevice(id: 'd2', name: '小明的 iPhone', pairedAt: 2),
              ],
            );
          case ('DELETE', '/api/v1/gate/devices/d2'):
            status = LanStatus(open: true, farm: 'lucas-mbp', url: _gate, devices: status.devices.where((d) => d.id != 'd2').toList());
          default:
            return jsonResponse({'_tag': 'Missing', 'what': r.url.path}, 404);
        }
        return jsonResponse(status.toJson());
      }),
    );

    Future<void> pump(WidgetTester t) async {
      t.view.physicalSize = const Size(1400, 1400);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(
        ProviderScope(
          overrides: [apiProvider.overrideWithValue(server())],
          child: MaterialApp(
            theme: farmTheme(),
            home: const Scaffold(body: GatePage()),
          ),
        ),
      );
      await settle(t);
    }

    setUp(() {
      writes = [];
      status = const LanStatus(open: false, farm: 'lucas-mbp', devices: []);
    });

    testWidgets('opens the gate', (t) async {
      await pump(t);
      expect(find.text('关着'), findsOneWidget);
      await t.tap(find.text('打开院门'));
      await settle(t);
      expect(writes, ['PUT /api/v1/gate {"open":true}']);
      expect(find.text(_gate), findsOneWidget);
      expect(find.text('添加设备'), findsOneWidget);
      await t.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('lets in the device asking, then removes it', (t) async {
      status = LanStatus(
        open: true,
        farm: 'lucas-mbp',
        url: _gate,
        pairing: LanPairing(
          code: 'ABC234',
          link: 'vibevalley://pair?u=x&c=ABC234',
          expiresAt: DateTime.now().millisecondsSinceEpoch + 60000.0,
          asking: '小明的 iPhone',
        ),
        devices: const [],
      );
      await pump(t);
      expect(find.text('「小明的 iPhone」想进院门。让它进来以后，它能和你一样用这个农场。'), findsOneWidget);
      await t.tap(find.text('让它进来'));
      await settle(t);
      expect(writes, ['POST /api/v1/gate/pairing/answer {"allow":true}']);
      expect(find.text('小明的 iPhone'), findsOneWidget);
      await t.tap(find.text('移除'));
      await settle(t);
      expect(writes.last, startsWith('DELETE /api/v1/gate/devices/d2'));
      expect(find.text('小明的 iPhone'), findsNothing);
      await t.pumpWidget(const SizedBox.shrink());
    });
  });
}
