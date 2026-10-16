import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/farm_choice.dart';
import '../../data/server.dart';
import '../../desktop/desktop.dart' show startLocalFarm;
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../connectors/qr.dart';
import '../runtimes/layout.dart';
import '../shared/state.dart';
import '../shared/widgets.dart';
import 'scan_page.dart';

const _pollEvery = Duration(milliseconds: 1500);

bool get canScan => Platform.isIOS || Platform.isAndroid;

class GatePage extends ConsumerStatefulWidget {
  const GatePage({super.key});

  @override
  ConsumerState<GatePage> createState() => _GatePageState();
}

class _GatePageState extends ConsumerState<GatePage> {
  LanStatus? _status;
  String? _unreachable;
  Timer? _poll;

  /// The gate is managed from the machine whose farm it is: not while this app uses another's.
  bool get _ownFarm => farmChoice.value.using == null;

  @override
  void initState() {
    super.initState();
    if (_ownFarm) {
      unawaited(_refresh());
      _poll = Timer.periodic(_pollEvery, (_) => unawaited(_refresh()));
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  LanApi get _api => ref.read(deskApiProvider).lan;

  Future<void> _refresh() async {
    try {
      final got = await _api.status();
      if (!mounted) return;
      setState(() {
        _status = got;
        _unreachable = null;
      });
    } on Object catch (e) {
      if (mounted) setState(() => _unreachable = reasonOf(e));
    }
  }

  Future<void> _act(Future<LanStatus> Function(LanApi api) call) async {
    final got = await deskRun(() => call(_api));
    if (got != null && mounted) setState(() => _status = got);
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    return Padding(
      // The cards' outlines and drops whole: a little room above the first.
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: PxScrollView(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_ownFarm) ...[
                  _GateCard(status: status, unreachable: _unreachable, act: _act),
                  if (status != null && status.devices.isNotEmpty) ...[const SizedBox(height: 12), _DevicesCard(devices: status.devices, act: _act)],
                  const SizedBox(height: 12),
                ],
                const _OtherFarmCard(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GateCard extends StatelessWidget {
  const _GateCard({required this.status, required this.unreachable, required this.act});
  final LanStatus? status;
  final String? unreachable;
  final Future<void> Function(Future<LanStatus> Function(LanApi api) call) act;

  @override
  Widget build(BuildContext context) {
    final body = KitText.sm.copyWith(color: Palette.bark800, height: 1.625);
    final s = status;
    return PxCard(
      title: '这台电脑的院门',
      aside: s == null ? null : Text(s.open ? '开着' : '关着'),
      child: s == null
          ? Text(unreachable ?? '在问服务端……', style: body)
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (!s.open) ...[
                  Text('打开院门，同一个局域网里的手机或另一台 Mac 扫码配对以后，就能用这台电脑上的农场：看帮工、派活、在田头说话。', style: body),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: PxButton.text(
                      '打开院门',
                      tone: PxTone.primary,
                      onPressed: () => act((api) => api.setOpen(body: const SetOpenRequest(open: true))),
                    ),
                  ),
                ] else ...[
                  _Row('地址', SelectableText(s.url ?? '—', style: KitText.mono.copyWith(color: Palette.bark900))),
                  if (s.pairing case final pairing?)
                    _Pairing(pairing: pairing, act: act)
                  else
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        PxButton.text('添加设备', tone: PxTone.primary, onPressed: s.url == null ? null : () => act((api) => api.startPairing())),
                        PxButton.text('关上院门', onPressed: () => act((api) => api.setOpen(body: const SetOpenRequest(open: false)))),
                      ],
                    ),
                ],
                if (s.problem case final problem?)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(problem, style: KitText.sm.copyWith(color: Palette.berry)),
                  ),
                const SizedBox(height: 12),
                for (final n in const [
                  '帮工能在这台电脑上跑命令，所以院门只让配对过的设备进来；配对要你在这里点头。',
                  '配对过的设备和你一样用这个农场。院门的开关和设备只能在这台电脑上管。',
                  '院门走的是不加密的 HTTP：同一个网络里的人可能看到传的内容。只在信得过的网络里开，比如家里的 Wi-Fi、自己的热点。',
                  '电脑换了地址（换了网络）以后，设备连不上了，在这里添加设备再扫一次就好，不用重新点头。',
                ])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text('· $n', style: KitText.xs.copyWith(color: Palette.bark500, height: 1.625)),
                  ),
              ],
            ),
    );
  }
}

class _Pairing extends StatelessWidget {
  const _Pairing({required this.pairing, required this.act});
  final LanPairing pairing;
  final Future<void> Function(Future<LanStatus> Function(LanApi api) call) act;

  @override
  Widget build(BuildContext context) {
    final body = KitText.sm.copyWith(color: Palette.bark800, height: 1.625);
    if (pairing.asking case final asking?) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('「$asking」想进院门。让它进来以后，它能和你一样用这个农场。', style: body),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              PxButton.text(
                '让它进来',
                tone: PxTone.primary,
                onPressed: () => act((api) => api.answerPairing(body: const AnswerPairingRequest(allow: true))),
              ),
              PxButton.text(
                '不让',
                tone: PxTone.danger,
                onPressed: () => act((api) => api.answerPairing(body: const AnswerPairingRequest(allow: false))),
              ),
            ],
          ),
        ],
      );
    }
    final left = ((pairing.expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000).ceil().clamp(0, 999);
    QrCode? code;
    try {
      code = QrCode.encode(pairing.link);
    } on ArgumentError {
      code = null;
    }
    return Wrap(
      spacing: 20,
      runSpacing: 16,
      children: [
        Semantics(
          container: true,
          image: true,
          label: '配对二维码',
          child: Container(
            width: 224,
            height: 224,
            padding: const EdgeInsets.all(8),
            color: const Color(0xFFFFFFFF),
            child: code != null ? QrImage(code) : null,
          ),
        ),
        ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 200, maxWidth: 420),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('手机打开 VibeValley，在「院门」里扫这个码；另一台 Mac 在它的「院门」里粘贴这个链接：', style: body),
              const SizedBox(height: 8),
              SelectableText(pairing.link, style: KitText.mono.copyWith(fontSize: 11, color: Palette.bark900)),
              const SizedBox(height: 8),
              Text('还有 $left 秒有效，只能用一次。', style: KitText.xs.copyWith(color: Palette.bark500)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: [
                  PxButton(
                    child: const Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon('button-copy', size: 16), SizedBox(width: 6), Text('复制链接')]),
                    onPressed: () {
                      unawaited(Clipboard.setData(ClipboardData(text: pairing.link)));
                      toasts.add(type: ToastType.info, title: '复制好了', description: '粘贴到另一台 Mac 的「院门」里。');
                    },
                  ),
                  PxButton.text('换一个码', onPressed: () => act((api) => api.startPairing())),
                  PxButton.text('不加了', onPressed: () => act((api) => api.stopPairing())),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _DevicesCard extends StatelessWidget {
  const _DevicesCard({required this.devices, required this.act});
  final List<LanDevice> devices;
  final Future<void> Function(Future<LanStatus> Function(LanApi api) call) act;

  @override
  Widget build(BuildContext context) => PxCard(
    title: '配对过的设备',
    aside: Text('${devices.length} 台'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final d in devices)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                Expanded(child: RowText(d.name, '配对于 ${momentText(d.pairedAt)} · ${d.lastSeen != null ? '上次来 ${momentText(d.lastSeen!)}' : '还没来过'}')),
                const SizedBox(width: 8),
                PxButton.text(
                  '移除',
                  tone: PxTone.danger,
                  size: PxSize.sm,
                  onPressed: () => act((api) => api.forgetDevice(id: d.id)),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}

class _OtherFarmCard extends StatefulWidget {
  const _OtherFarmCard();

  @override
  State<_OtherFarmCard> createState() => _OtherFarmCardState();
}

class _OtherFarmCardState extends State<_OtherFarmCard> {
  String _link = '';
  String? _waiting;
  String? _error;

  Future<void> _connect(String text) async {
    final link = PairLink.parse(text);
    if (link == null) {
      setState(() => _error = '这不是院门的配对链接：它以 vibevalley://pair 开头');
      return;
    }
    setState(() {
      _waiting = link.url.host;
      _error = null;
    });
    try {
      final remote = await pairWith(
        link,
        name: deviceName(),
        known: farmChoice.value.remote,
        apiFor: (url, key) => VibeValleyServer(url, key: key).api,
      );
      toasts.add(type: ToastType.info, title: '进院门了', description: '现在用的是 ${remote.farm} 的农场。');
      await saveFarmChoice(FarmChoice(remote: remote, useRemote: true));
    } on Object catch (e) {
      if (mounted) setState(() => _error = reasonOf(e));
    } finally {
      if (mounted) setState(() => _waiting = null);
    }
  }

  Future<void> _scan() async {
    final got = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const ScanPage()));
    if (got != null && mounted) await _connect(got);
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (data?.text case final text? when mounted) setState(() => _link = text.trim());
  }

  Future<void> _useOwn() async {
    await startLocalFarm();
    await saveFarmChoice(FarmChoice(remote: farmChoice.value.remote));
  }

  @override
  Widget build(BuildContext context) {
    final body = KitText.sm.copyWith(color: Palette.bark800, height: 1.625);
    final choice = farmChoice.value;
    final using = choice.using;
    final own = canScan ? '断开' : '回到这台电脑的农场';
    return PxCard(
      title: '连到别处的农场',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (using != null) ...[
            Text('正在用 ${using.farm} 的农场（${using.url.authority}）。', style: body),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: PxButton.text(own, onPressed: _waiting != null ? null : _useOwn),
            ),
            const SizedBox(height: 16),
            Text('那台电脑换了地址，或者要换一个农场：在那台电脑的院门里添加设备，再扫码或粘贴链接。', style: KitText.xs.copyWith(color: Palette.bark500)),
          ] else ...[
            Text('在另一台电脑的 VibeValley 里打开「院门」、点「添加设备」，${canScan ? '扫它给的码，或者' : ''}把它给的链接粘贴在这里。', style: body),
            if (choice.remote case final last?) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('上次用过 ${last.farm} 的农场。', style: body),
                  PxButton.text(
                    '连回去',
                    size: PxSize.sm,
                    onPressed: _waiting != null ? null : () => saveFarmChoice(FarmChoice(remote: last, useRemote: true)),
                  ),
                ],
              ),
            ],
          ],
          const SizedBox(height: 12),
          if (canScan) ...[
            Align(
              alignment: Alignment.centerLeft,
              child: PxButton.text('扫码', tone: PxTone.primary, onPressed: _waiting != null ? null : _scan),
            ),
            const SizedBox(height: 12),
          ],
          Row(
            children: [
              Expanded(
                child: PxTextInput(
                  value: _link,
                  onChanged: (v) => setState(() => _link = v),
                  placeholder: 'vibevalley://pair?u=…',
                  mono: true,
                  semanticLabel: '配对链接',
                  enabled: _waiting == null,
                  onSubmitted: (v) => _connect(v),
                ),
              ),
              const SizedBox(width: 8),
              PxButton.text('粘贴', onPressed: _waiting != null ? null : _paste),
              const SizedBox(width: 8),
              PxButton.text(
                '连接',
                tone: canScan ? PxTone.plain : PxTone.primary,
                onPressed: _waiting != null || _link.trim().isEmpty ? null : () => _connect(_link),
              ),
            ],
          ),
          if (_waiting case final host?)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text('等 $host 那台电脑上点「让它进来」……', style: body),
            ),
          if (_error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(error, style: KitText.sm.copyWith(color: Palette.berry)),
            ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.child);
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: KitText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}
