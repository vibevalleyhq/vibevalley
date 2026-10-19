// The app shows only what is real, so without the server there is nothing to show.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/farm_choice.dart';
import '../data/providers.dart';
import '../ui/kit/kit.dart';

const healthEvery = Duration(seconds: 4);

/// true until the first check says otherwise.
final serverReachableProvider = StreamProvider<bool>((ref) async* {
  final server = ref.watch(serverProvider);
  while (true) {
    yield await server.healthy();
    await Future<void>.delayed(healthEvery);
  }
});

bool watchReachable(WidgetRef ref) => ref.watch(serverReachableProvider).value ?? true;

class ConnectionBanner extends ConsumerWidget {
  const ConnectionBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (watchReachable(ref)) return const SizedBox.shrink();
    const text = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 20 / 14, color: Palette.bark900);
    final code = KitText.mono.copyWith(color: Palette.bark900);
    final remote = farmConnection.value.remote;
    return Semantics(
      liveRegion: true,
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 672),
            child: PxWindow(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text.rich(
                TextSpan(
                  style: text,
                  children: [
                    if (remote != null) ...[
                      TextSpan(
                        text: '连不上 ${remote.hostName} 的农场（${remote.url.authority}）。',
                        style: const TextStyle(color: Palette.berry),
                      ),
                      const TextSpan(text: '那台电脑要开着、要允许连接，两台设备在同一个网络里；它换了地址就到'),
                    ] else ...[
                      const TextSpan(
                        text: '连不上 VibeValley 服务端。',
                        style: TextStyle(color: Palette.berry),
                      ),
                      const TextSpan(text: '先启动它（'),
                      TextSpan(text: 'cd server && go run ./cmd/server', style: code),
                      const TextSpan(text: '，或者打开桌面客户端），连上后这里会自己好；要用别的电脑上的农场，到'),
                    ],
                    WidgetSpan(
                      alignment: PlaceholderAlignment.baseline,
                      baseline: TextBaseline.alphabetic,
                      child: TextLink('连接到本机', underline: true, style: text, onTap: () => context.go('/settings/lan')),
                    ),
                    TextSpan(text: remote != null ? '重新扫码。' : '扫码。'),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
