// 连接器 (web/src/pages/ConnectorsPage.tsx): doors into the farm from chat apps. WeChat and Feishu log in by scanning a
// code with the phone; QQ takes its bot's AppID and AppSecret. Feishu and QQ then show a pairing code: whoever sends it
// to the bot is the owner, the only one heard. What the owner sends is said in its channel (田头 unless moved); what
// the farm says to them goes back. The page asks the server every 1.5 s while it is open: a login waits for the scan.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import '../../ui/kit/kit.dart';
import '../runtimes/layout.dart';
import 'qr.dart';
import '../shared/widgets.dart';
import '../shared/state.dart';
import '../../rules/chat.dart';

/// protocol CONNECTOR_LABEL.
const connectorLabel = <ConnectorId, String>{ConnectorId.weixin: '微信', ConnectorId.feishu: '飞书', ConnectorId.qq: 'QQ'};

/// How each logs in, under its name in the list.
const _how = <ConnectorId, String>{ConnectorId.weixin: '扫码登录，私聊机器人', ConnectorId.feishu: '扫码自动建机器人', ConnectorId.qq: '填 QQ 机器人的 AppID'};

/// What to know about each, under its card.
const _notes = <ConnectorId, List<String>>{
  ConnectorId.weixin: [
    '只认扫码的那个微信：别人给这个机器人发的话进不了农场。',
    '帮工干完活，汇报马上发到微信上，不用等你先说话。微信偶尔不收时，汇报先攒着，隔一会儿再试（越隔越久，最多半小时），你下次说一句也会一起发过来（多了合成一条）。',
    '用的是腾讯官方给机器人用的接口（和 OpenClaw 的微信插件一样）。',
  ],
  ConnectorId.feishu: ['扫码后，飞书会替你建一个只属于你的机器人应用，不用去开放平台手动配。', '建好后在飞书里找到这个机器人，私聊它发配对码：发了码的人就是主人，只有主人的话进农场。只收私聊，群里的不收。', '飞书的机器人可以随时给你发消息，汇报不用等你先说话。'],
  ConnectorId.qq: [
    'QQ 没有扫码建机器人：先在 QQ 开放平台（q.qq.com）建一个机器人，打开「单聊」消息，把 AppID 和 AppSecret 填在这里。',
    '用你自己的 QQ 加这个机器人，私聊它发配对码：发了码的人就是主人。只收私聊。',
    'QQ 只让机器人在你说话后的一小段时间里回复。过了时间的汇报先攒着，隔一会儿再试，你下次说一句就一起发过来。',
  ],
};

String stateLabel(ConnectorState s) => switch (s) {
  ConnectorState.off => '没连接',
  ConnectorState.waiting => '等你扫码',
  ConnectorState.scanned => '已扫码，等手机确认',
  ConnectorState.verify => '要输入手机上的数字',
  ConnectorState.pairing => '等你发配对码',
  ConnectorState.connected => '已连接',
  ConnectorState.paused => '暂停中',
};

/// How often the page asks while it is open.
const pollEvery = Duration(milliseconds: 1500);

/// Each connector's state as the server last told it; null before the first answer (packages/core connectors.ts).
final connectorsProvider = NotifierProvider<ConnectorsNotifier, Map<ConnectorId, ConnectorStatus>?>(ConnectorsNotifier.new);

class ConnectorsNotifier extends Notifier<Map<ConnectorId, ConnectorStatus>?> {
  @override
  Map<ConnectorId, ConnectorStatus>? build() => null;

  ConnectorsApi get _api => ref.read(deskApiProvider).connectors;

  void _keep(Iterable<ConnectorStatus> got) => state = {...?state, for (final s in got) s.id: s};

  /// Asks how every connector is doing; a failure is left for the next poll.
  Future<void> refresh() async {
    try {
      _keep(await _api.list());
    } catch (e) {
      debugPrint('vibevalley: connectors: $e');
    }
  }

  Future<void> login(ConnectorId id, [ConnectorLogin input = const ConnectorLogin()]) => _act(() => _api.login(id: id, body: input));
  Future<void> verify(ConnectorId id, String code) => _act(
    () => _api.verify(
      id: id,
      body: VerifyRequest(code: code),
    ),
  );
  Future<void> logout(ConnectorId id) => _act(() => _api.logout(id: id));

  Future<void> _act(Future<ConnectorStatus> Function() call) async {
    try {
      _keep([await call()]);
    } catch (e) {
      toasts.add(type: ToastType.error, title: noticeTitle[ToastType.error]!, description: '$e');
    }
  }

  /// Connects it to a channel, by name; throws why not.
  Future<void> setChannel(ConnectorId id, String channel) async => _keep([
    await _api.channel(
      id: id,
      body: ConnectorsChannelRequest(channel: channel),
    ),
  ]);
}

class ConnectorsPage extends ConsumerStatefulWidget {
  const ConnectorsPage({super.key, this.id});
  final String? id;

  @override
  ConsumerState<ConnectorsPage> createState() => _ConnectorsPageState();
}

class _ConnectorsPageState extends ConsumerState<ConnectorsPage> {
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    final notifier = ref.read(connectorsProvider.notifier);
    unawaited(notifier.refresh());
    _poll = Timer.periodic(pollEvery, (_) => unawaited(notifier.refresh()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final all = ref.watch(connectorsProvider);
    final atlas = ref.watch(atlasProvider).value;
    final selected = ConnectorId.values.where((c) => c.wire == widget.id).firstOrNull ?? ConnectorId.weixin;
    return ListDetail(
      list: ListCard(
        title: '连接器',
        note: '在聊天软件里和农场说话：派活、问进度、收汇报。',
        semanticLabel: '连接器列表',
        children: [
          for (final c in ConnectorId.values)
            ListRow(
              active: c == selected,
              onTap: () => deskGo(context, '/connectors/${c.wire}'),
              child: Row(
                children: [
                  if (atlas != null) SpriteIcon('connector-${c.wire}', size: 36),
                  const SizedBox(width: 10),
                  Expanded(child: RowText(connectorLabel[c]!, all?[c] != null && all![c]!.state != ConnectorState.off ? stateLabel(all[c]!.state) : _how[c]!)),
                  const SizedBox(width: 10),
                  StateDot(switch (all?[c]?.state) {
                    ConnectorState.connected => Palette.leaf500,
                    ConnectorState.pairing || ConnectorState.paused => Palette.wheat,
                    _ => Palette.cream300,
                  }),
                ],
              ),
            ),
        ],
      ),
      detail: all == null
          ? [PxCard(title: connectorLabel[selected], child: const Text('在问服务端……'))]
          : [
              _ConnectorCard(
                key: ValueKey(selected),
                id: selected,
                status: all[selected] ?? ConnectorStatus(id: selected, state: ConnectorState.off, pending: 0),
                atlas: atlas,
              ),
              PxCard(
                title: '要知道的',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final n in [..._notes[selected]!, '帮工能在这台电脑上跑命令，所以只认主人；回复时引用某条汇报，你的话会进那件活的工单串。农场只往外连，不开端口。'])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Text('· $n', style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625)),
                      ),
                  ],
                ),
              ),
            ],
    );
  }
}

class _ConnectorCard extends ConsumerStatefulWidget {
  const _ConnectorCard({super.key, required this.id, required this.status, required this.atlas});
  final ConnectorId id;
  final ConnectorStatus status;
  final SpriteAtlas? atlas;

  @override
  ConsumerState<_ConnectorCard> createState() => _ConnectorCardState();
}

class _ConnectorCardState extends ConsumerState<_ConnectorCard> {
  bool _busy = false;

  Future<void> _act(Future<void> Function(ConnectorsNotifier n) run) async {
    setState(() => _busy = true);
    try {
      await run(ref.read(connectorsProvider.notifier));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.id;
    final status = widget.status;
    final label = connectorLabel[id]!;
    final body = KitText.sm.copyWith(color: Palette.bark800);
    final disconnect = Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: PxButton.text('断开', tone: PxTone.danger, onPressed: _busy ? null : () => _act((n) => n.logout(id))),
      ),
    );
    return PxCard(
      title: label,
      aside: Text(stateLabel(status.state)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          ...switch (status.state) {
            ConnectorState.off => [
              if (id == ConnectorId.qq)
                _QqLogin(
                  busy: _busy,
                  onLogin: (appId, secret) => _act((n) => n.login(id, ConnectorLogin(appId: appId, secret: secret))),
                )
              else ...[
                Text(
                  id == ConnectorId.weixin ? '用手机微信扫一个码，就能在微信里和管家说话：派活、问进度，帮工的汇报和提问也会发到微信上。' : '用手机飞书扫一个码，飞书会替你建一个机器人；在飞书里和它说话，就是和管家说话。',
                  style: body.copyWith(height: 1.625),
                ),
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerLeft,
                  child: PxButton.text('$label扫码登录', tone: PxTone.primary, onPressed: _busy ? null : () => _act((n) => n.login(id))),
                ),
              ],
            ],
            ConnectorState.waiting || ConnectorState.scanned || ConnectorState.verify => [
              _LoginCode(
                status: status,
                busy: _busy,
                app: label,
                onRefresh: () => _act((n) => n.login(id, const ConnectorLogin(force: true))),
                onVerify: (code) => _act((n) => n.verify(id, code)),
              ),
            ],
            ConnectorState.pairing => [
              Text('机器人连上了。最后一步：用你自己的$label，私聊这个机器人，发：', style: body),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Container(
                  color: Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: SelectableText(status.pairCode ?? '', style: KitText.mono.copyWith(fontSize: 30, letterSpacing: 4, color: Palette.bark900)),
                ),
              ),
              const SizedBox(height: 12),
              Text('发了这个码的人就是主人：以后只有他的话进农场。码只能用一次。', style: KitText.xs.copyWith(color: Palette.bark500)),
              disconnect,
            ],
            ConnectorState.connected || ConnectorState.paused => [
              _Row('主人', Text(status.owner ?? '', style: body)),
              _Row('接在', _ChannelPick(id: id, current: status.channel ?? '田头')),
              if (status.since case final since?) _Row('连上的时间', Text(momentText(since), style: body)),
              _Row('上次收到你的话', Text(status.lastInbound != null ? momentText(status.lastInbound!) : '还没有', style: body)),
              _Row('等着发给你的', Text(status.pending > 0 ? '${status.pending.round()} 条：你下次说话时一起发' : '没有', style: body)),
              if (status.state == ConnectorState.paused && status.pausedUntil != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text('登录过期了，${wallClockText(status.pausedUntil!)} 后再试；也可以断开重新连。', style: KitText.sm.copyWith(color: Palette.berry)),
                ),
              disconnect,
            ],
          },
          if (status.error case final error?)
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
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 112,
          child: Text(label, style: KitText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}

/// Which channel the owner's words go into, and whose words come back out.
class _ChannelPick extends ConsumerStatefulWidget {
  const _ChannelPick({required this.id, required this.current});
  final ConnectorId id;
  final String current;

  @override
  ConsumerState<_ChannelPick> createState() => _ChannelPickState();
}

class _ChannelPickState extends ConsumerState<_ChannelPick> {
  String? _error;

  @override
  Widget build(BuildContext context) {
    final channels = channelsOf(ref.watch(farmProvider)?.chat);
    return Wrap(
      spacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        SizedBox(
          width: 200,
          child: PxPick(
            value: widget.current,
            placeholder: '接在哪个频道',
            semanticLabel: '接在哪个频道',
            options: [
              for (final c in channels) PickOption(value: c.name ?? '田头', label: c.kind == ConversationKind.square ? '田头' : '#${c.name}'),
              // The one it is in, even before the farm's chat has come.
              if (!channels.any((c) => (c.name ?? '田头') == widget.current)) PickOption(value: widget.current, label: widget.current),
            ],
            onChanged: (v) async {
              if (v.isEmpty) return;
              setState(() => _error = null);
              try {
                await ref.read(connectorsProvider.notifier).setChannel(widget.id, v);
              } catch (e) {
                if (mounted) setState(() => _error = '$e');
              }
            },
          ),
        ),
        if (_error != null) Text(_error!, style: KitText.xs.copyWith(color: Palette.berry)),
      ],
    );
  }
}

class _QqLogin extends StatefulWidget {
  const _QqLogin({required this.busy, required this.onLogin});
  final bool busy;
  final void Function(String appId, String secret) onLogin;

  @override
  State<_QqLogin> createState() => _QqLoginState();
}

class _QqLoginState extends State<_QqLogin> {
  String _appId = '';
  String _secret = '';

  @override
  Widget build(BuildContext context) {
    final ready = !widget.busy && _appId.trim().isNotEmpty && _secret.trim().isNotEmpty;
    void submit() {
      if (ready) widget.onLogin(_appId, _secret);
    }

    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 448),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: '在 '),
                  WidgetSpan(
                    alignment: PlaceholderAlignment.baseline,
                    baseline: TextBaseline.alphabetic,
                    child: TextLink('QQ 开放平台', underline: true, style: KitText.xs, onTap: () => openLink('https://q.qq.com/')),
                  ),
                  const TextSpan(text: ' 建一个机器人，打开单聊消息，把它的 AppID 和 AppSecret 填在这里。'),
                ],
              ),
              style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625),
            ),
            const SizedBox(height: 12),
            PxField(
              label: 'AppID',
              child: PxTextInput(
                value: _appId,
                onChanged: (v) => setState(() => _appId = v),
                placeholder: '102xxxxxx',
                mono: true,
                semanticLabel: 'AppID',
                onSubmitted: (_) => submit(),
              ),
            ),
            const SizedBox(height: 12),
            PxField(
              label: 'AppSecret',
              hint: const Text('只存在这台电脑的农场数据库里，不会再显示。'),
              child: PxTextInput(
                value: _secret,
                onChanged: (v) => setState(() => _secret = v),
                placeholder: '机器人密钥',
                mono: true,
                semanticLabel: 'AppSecret',
                onSubmitted: (_) => submit(),
              ),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: PxButton.text('连接 QQ 机器人', tone: PxTone.primary, onPressed: ready ? submit : null),
            ),
          ],
        ),
      ),
    );
  }
}

/// The login code, drawn here from what it encodes; and the number box when WeChat asks for it.
class _LoginCode extends StatefulWidget {
  const _LoginCode({required this.status, required this.busy, required this.app, required this.onRefresh, required this.onVerify});
  final ConnectorStatus status;
  final bool busy;
  final String app;
  final VoidCallback onRefresh;
  final ValueChanged<String> onVerify;

  @override
  State<_LoginCode> createState() => _LoginCodeState();
}

class _LoginCodeState extends State<_LoginCode> {
  String _code = '';
  String? _encoded;
  QrCode? _qr;

  QrCode? get _drawn {
    final qr = widget.status.qr;
    if (qr != _encoded) {
      _encoded = qr;
      try {
        _qr = qr == null ? null : QrCode.encode(qr);
      } on ArgumentError {
        _qr = null;
      }
    }
    return _qr;
  }

  @override
  Widget build(BuildContext context) {
    final status = widget.status;
    final code = _drawn;
    final body = KitText.sm.copyWith(color: Palette.bark800);
    return Wrap(
      spacing: 20,
      runSpacing: 16,
      crossAxisAlignment: WrapCrossAlignment.start,
      children: [
        Semantics(
          container: true,
          image: true,
          label: '${widget.app}登录二维码',
          child: Container(
            width: 224,
            height: 224,
            padding: const EdgeInsets.all(8),
            color: const Color(0xFFFFFFFF),
            alignment: Alignment.center,
            child: code != null ? QrImage(code) : Text('在拿二维码……', style: KitText.xs.copyWith(color: Palette.bark500)),
          ),
        ),
        ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 200, maxWidth: 420),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(switch (status.state) {
                ConnectorState.waiting => '用手机${widget.app}扫这个码。',
                ConnectorState.scanned => '扫好了，在手机上点确认。',
                ConnectorState.verify => '输入手机上显示的数字：',
                _ => '',
              }, style: body),
              if (status.state == ConnectorState.verify) ...[
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: PxTextInput(value: _code, onChanged: (v) => setState(() => _code = v), placeholder: '手机上的数字', semanticLabel: '手机上的数字'),
                    ),
                    const SizedBox(width: 8),
                    PxButton.text('确定', tone: PxTone.primary, onPressed: widget.busy || _code.trim().isEmpty ? null : () => widget.onVerify(_code)),
                  ],
                ),
              ],
              if (status.qr case final qr?) ...[
                const SizedBox(height: 12),
                Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(text: '扫不了？在手机上打开这个链接：'),
                      WidgetSpan(
                        child: TextLink(qr, underline: true, onTap: () => openLink(qr), style: KitText.xs),
                      ),
                    ],
                  ),
                  style: KitText.xs.copyWith(color: Palette.bark500),
                ),
              ],
              const SizedBox(height: 12),
              PxButton.text('换一个码', onPressed: widget.busy ? null : widget.onRefresh),
            ],
          ),
        ),
      ],
    );
  }
}
