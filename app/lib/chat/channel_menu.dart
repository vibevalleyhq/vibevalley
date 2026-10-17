import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../shell/sfx.dart';
import '../ui/kit/kit.dart';
import 'chat_rules.dart';
import 'chat_state.dart';
import 'chat_widgets.dart';
import '../rules/chat.dart';

enum _Mode { list, create, settings, schedules }

const _grey = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.bark500);

class ChannelMenu extends ConsumerStatefulWidget {
  const ChannelMenu({super.key, required this.current});
  final Conversation? current;

  @override
  ConsumerState<ChannelMenu> createState() => _ChannelMenuState();
}

class _ChannelMenuState extends ConsumerState<ChannelMenu> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  _Mode _mode = _Mode.list;

  void _toggle() {
    if (_portal.isShowing) {
      _portal.hide();
    } else {
      Sfx.play('open');
      _portal.show();
    }
    setState(() => _mode = _Mode.list);
  }

  void _close() {
    _portal.hide();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(stateProvider)?.chat;
    final channels = channelsOf(chat);
    final current = widget.current;
    final elsewhere = channels.where((c) => c.id != current?.id).fold(0, (n, c) => n + unreadUnder(chat, c));
    return CompositedTransformTarget(
      link: _link,
      child: OverlayPortal(
        controller: _portal,
        overlayChildBuilder: (context) => CompositedTransformFollower(
          link: _link,
          targetAnchor: Alignment.bottomLeft,
          offset: const Offset(0, 6),
          child: Align(
            alignment: Alignment.topLeft,
            child: TapRegion(
              groupId: _link,
              // The forms' project suggestions open in an overlay of their own: a tap there is not outside.
              onTapOutside: (_) => _mode == _Mode.list || _mode == _Mode.schedules ? _close() : null,
              child: SizedBox(
                width: 288,
                child: PxWindow(
                  padding: const EdgeInsets.all(8),
                  child: Material(
                    type: MaterialType.transparency,
                    child: DefaultTextStyle(style: KitText.sm, child: _body(chat, channels, current)),
                  ),
                ),
              ),
            ),
          ),
        ),
        child: TapRegion(
          groupId: _link,
          child: KitTappable(
            onTap: _toggle,
            semanticLabel: '频道：${channelLabel(current)}，点开切换或开新频道',
            builder: (context, s) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              color: s.hovered ? Palette.cream200 : null,
              foregroundDecoration: pxRing,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(channelLabel(current), maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
                  ),
                  if (elsewhere > 0) ...[
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      color: Palette.berry.withValues(alpha: .15),
                      child: Text('$elsewhere', style: KitText.xs.copyWith(color: Palette.berry)),
                    ),
                  ],
                  const SizedBox(width: 4),
                  const RotatedBox(quarterTurns: 1, child: SpriteIcon('button-next', size: 10)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(Chat? chat, List<Conversation> channels, Conversation? current) => switch (_mode) {
    _Mode.list => _list(chat, channels, current),
    _Mode.create => NewChannelPanel(onDone: _close, onBack: () => setState(() => _mode = _Mode.list)),
    _Mode.schedules => ScheduleList(
      schedules: ref.watch(stateProvider)?.schedules ?? const [],
      channels: channels,
      onBack: () => setState(() => _mode = _Mode.list),
    ),
    _Mode.settings =>
      current == null ? const SizedBox() : ChannelSettingsPanel(channel: current, onDone: _close, onBack: () => setState(() => _mode = _Mode.list)),
  };

  Widget _list(Chat? chat, List<Conversation> channels, Conversation? current) {
    final schedules = ref.watch(stateProvider)?.schedules ?? const <Schedule>[];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 288),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final c in channels)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: KitTappable(
                    onTap: () {
                      _close();
                      unawaited(ref.read(chatActionsProvider).showChat(c.kind == ConversationKind.general ? null : c.id).catchError((Object _) {}));
                    },
                    selected: c.id == current?.id,
                    builder: (context, s) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      color: c.id == current?.id ? Palette.leaf300.withValues(alpha: .5) : (s.hovered ? Palette.cream200 : null),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(channelLabel(c), maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
                                if ((c.description ?? '').isNotEmpty || (c.project ?? '').isNotEmpty)
                                  Text(
                                    [if ((c.description ?? '').isNotEmpty) c.description!, if ((c.project ?? '').isNotEmpty) '项目 ${c.project}'].join(' · '),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: _grey,
                                  ),
                              ],
                            ),
                          ),
                          if (unreadUnder(chat, c) > 0) CountChip(unreadUnder(chat, c), fill: Palette.berry),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.only(top: 4),
          padding: const EdgeInsets.only(top: 4),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Palette.cream200)),
          ),
          child: Row(
            children: [
              Expanded(
                child: _Link(
                  onTap: () => setState(() => _mode = _Mode.create),
                  color: Palette.leaf700,
                  child: const Row(children: [SpriteIcon('button-add', size: 12), SizedBox(width: 4), Text('开新频道')]),
                ),
              ),
              _Link(
                onTap: () => setState(() => _mode = _Mode.schedules),
                child: Text('定时${schedules.isEmpty ? '' : ' ${schedules.where((s) => s.enabled).length}'}'),
              ),
              _Link(
                onTap: () {
                  _close();
                  context.go(current == null || current.kind == ConversationKind.general ? '/chat' : '/chat/${current.id}');
                },
                child: const Row(children: [SpriteIcon('button-open', size: 12), SizedBox(width: 4), Text('频道页')]),
              ),
              if (current != null)
                _Link(
                  onTap: () => setState(() => _mode = _Mode.settings),
                  child: const Row(children: [SpriteIcon('button-settings', size: 12), SizedBox(width: 4), Text('设置')]),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.onTap, required this.child, this.color = Palette.bark600});
  final VoidCallback onTap;
  final Widget child;
  final Color color;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    builder: (context, s) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      color: s.hovered ? Palette.cream200 : null,
      child: DefaultTextStyle(
        style: KitText.sm.copyWith(color: color),
        child: IconTheme.merge(
          data: IconThemeData(color: color),
          child: child,
        ),
      ),
    ),
  );
}

class _FormButtons extends StatelessWidget {
  const _FormButtons({required this.onBack, required this.submit, required this.onSubmit});
  final VoidCallback onBack;
  final String submit;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.end,
    children: [
      _Link(onTap: onBack, child: const Text('返回')),
      const SizedBox(width: 4),
      PxButton.text(submit, size: PxSize.sm, tone: PxTone.primary, onPressed: onSubmit),
    ],
  );
}

class NewChannelPanel extends ConsumerStatefulWidget {
  const NewChannelPanel({super.key, required this.onDone, required this.onBack});
  final VoidCallback onDone;
  final VoidCallback onBack;

  @override
  ConsumerState<NewChannelPanel> createState() => _NewChannelPanelState();
}

class _NewChannelPanelState extends ConsumerState<NewChannelPanel> {
  String _name = '';
  String _description = '';
  String _project = '';
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await ref
          .read(chatActionsProvider)
          .openChannel(
            ChannelRequest(name: _name, description: _description.trim().isEmpty ? null : _description, project: _project.trim().isEmpty ? null : _project),
          );
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemOf(e);
        });
      }
      return;
    }
    Sfx.play('open');
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(chatProjectNamesProvider).value ?? const <String>[];
    return Padding(
      padding: const EdgeInsets.all(4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('开新频道', style: KitText.sm),
          const SizedBox(height: 8),
          const Text('一件长期的事、一个项目，单独一个地方说话、派活。在这里叫管家，活就派在这里。', style: _grey),
          const SizedBox(height: 8),
          PxTextInput(
            value: _name,
            autofocus: true,
            onChanged: (v) => setState(() {
              _name = v;
              _error = null;
            }),
            placeholder: '名字，比如 clock-in',
            semanticLabel: '频道名',
          ),
          const SizedBox(height: 8),
          PxTextInput(value: _description, onChanged: (v) => setState(() => _description = v), placeholder: '做什么的（可以不填）', semanticLabel: '频道说明'),
          const SizedBox(height: 8),
          PxTextInput(value: _project, onChanged: (v) => setState(() => _project = v), placeholder: '默认项目（可以不填）', semanticLabel: '默认项目', suggestions: projects),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          const SizedBox(height: 8),
          _FormButtons(onBack: widget.onBack, submit: '开', onSubmit: _busy || _name.trim().isEmpty ? null : _submit),
        ],
      ),
    );
  }
}

class ChannelSettingsPanel extends ConsumerStatefulWidget {
  const ChannelSettingsPanel({super.key, required this.channel, required this.onDone, required this.onBack});
  final Conversation channel;
  final VoidCallback onDone;
  final VoidCallback onBack;

  @override
  ConsumerState<ChannelSettingsPanel> createState() => _ChannelSettingsPanelState();
}

class _ChannelSettingsPanelState extends ConsumerState<ChannelSettingsPanel> {
  late final Conversation _latest = conversationOf(ref.read(stateProvider)?.chat, widget.channel.id) ?? widget.channel;
  late String _description = _latest.description ?? '';
  late String _project = _latest.project ?? '';
  String? _error;

  Future<void> _submit() async {
    try {
      await ref.read(chatActionsProvider).updateChannel(widget.channel.id, ChannelUpdate(description: _description, project: _project));
    } on Object catch (e) {
      if (mounted) setState(() => _error = problemOf(e));
      return;
    }
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(chatProjectNamesProvider).value ?? const <String>[];
    return Padding(
      padding: const EdgeInsets.all(4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('${channelLabel(_latest)} 的设置', style: KitText.sm),
          const SizedBox(height: 8),
          PxTextInput(value: _description, onChanged: (v) => setState(() => _description = v), placeholder: '做什么的', semanticLabel: '频道说明'),
          const SizedBox(height: 8),
          PxTextInput(
            value: _project,
            onChanged: (v) => setState(() => _project = v),
            placeholder: '默认项目（空着就没有）',
            semanticLabel: '默认项目',
            suggestions: projects,
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          const SizedBox(height: 8),
          _FormButtons(onBack: widget.onBack, submit: '存', onSubmit: _submit),
        ],
      ),
    );
  }
}

class ScheduleList extends ConsumerStatefulWidget {
  const ScheduleList({super.key, required this.schedules, required this.channels, required this.onBack});
  final List<Schedule> schedules;
  final List<Conversation> channels;
  final VoidCallback onBack;

  @override
  ConsumerState<ScheduleList> createState() => _ScheduleListState();
}

class _ScheduleListState extends ConsumerState<ScheduleList> {
  String? _error;
  String? _deleting;

  Future<void> _act(Future<void> Function() effect) async {
    setState(() => _error = null);
    try {
      await effect();
    } on Object catch (e) {
      if (mounted) setState(() => _error = problemOf(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final actions = ref.read(chatActionsProvider);
    return Padding(
      padding: const EdgeInsets.all(4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('定时', style: KitText.sm),
          const SizedBox(height: 8),
          if (widget.schedules.isEmpty)
            const Text('还没有。跟管家说「每天早上九点在 #clock-in 跑一遍测试」，它会定好；到点了频道里出现一条，再派活。', style: _grey)
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 288),
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final s in widget.schedules)
                    Opacity(
                      opacity: s.enabled ? 1 : .6,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
                                ),
                                const SizedBox(width: 8),
                                KitTappable(
                                  onTap: () => _act(() => actions.setScheduleEnabled(s.id, !s.enabled)),
                                  semanticLabel: s.enabled ? '关掉定时「${s.name}」' : '打开定时「${s.name}」',
                                  builder: (context, _) => Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6),
                                    color: s.enabled ? Palette.leaf500 : Palette.cream200,
                                    child: Text(s.enabled ? '开着' : '关着', style: KitText.xs.copyWith(color: s.enabled ? Palette.cream50 : Palette.bark600)),
                                  ),
                                ),
                                const SizedBox(width: 4),
                                TapRegion(
                                  onTapOutside: (_) {
                                    if (_deleting == s.id) setState(() => _deleting = null);
                                  },
                                  child: KitTappable(
                                    onTap: () {
                                      if (_deleting == s.id) {
                                        _act(() => actions.removeSchedule(s.id));
                                      } else {
                                        setState(() => _deleting = s.id);
                                      }
                                    },
                                    semanticLabel: '删掉定时「${s.name}」',
                                    builder: (context, st) => Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4),
                                      color: st.hovered ? Palette.cream200 : null,
                                      child: _deleting == s.id
                                          ? Text('确定删？', style: KitText.xs.copyWith(color: Palette.berry))
                                          : const SpriteIcon('button-delete', size: 14),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            Text(
                              '${channelLabel(widget.channels.where((c) => c.id == s.channel).firstOrNull)} · ${s.whenText ?? ''}'
                              '${s.agent != null ? ' · 直接派 ${s.agent}' : ''} · 下次 ${s.nextText ?? ''}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: _grey,
                            ),
                            Text(
                              s.text,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: KitText.xs.copyWith(color: Palette.bark800),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: _Link(onTap: widget.onBack, child: const Text('返回')),
          ),
        ],
      ),
    );
  }
}
