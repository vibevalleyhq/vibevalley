import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';
import 'chat_composer.dart';
import '../../shared/chat_rules.dart';
import '../../chat/chat_state.dart';
import '../../shared/chat_widgets.dart';
import 'dialogs.dart';
import '../workbench_shell.dart' show workbenchHead;
import 'message_list.dart';
import '../../rules/chat.dart';
import '../../rules/sessions.dart';

enum _Tab { chat, jobs, schedules }

class ChatPage extends ConsumerStatefulWidget {
  const ChatPage({super.key, this.id});

  /// Shown once (/chat/7 from a link); then the page goes by what is shown.
  final String? id;

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage> {
  _Tab _tab = _Tab.chat;
  String? _search;
  bool _drawer = false;
  String? _channelShown;

  @override
  void initState() {
    super.initState();
    _route();
  }

  @override
  void didUpdateWidget(ChatPage old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id) _route();
  }

  void _route() {
    final id = widget.id;
    if (id == null) return;
    // After the first frame: the provider is not changed while the tree builds.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(chatActionsProvider).showChat(id).catchError((Object _) {}));
    });
  }

  void _show(String? id) => unawaited(ref.read(chatActionsProvider).showChat(id).catchError((Object _) {}));

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(stateProvider);
    final chat = farm?.chat;
    final shown = ref.watch(shownConversationProvider);
    final channels = channelsOf(chat);
    final channel = channelOf(chat, shown) ?? channels.firstOrNull;
    final thread = shown?.kind == ConversationKind.thread ? shown : null;
    if (channel?.id != _channelShown) {
      _channelShown = channel?.id;
      _search = null;
      _tab = _Tab.chat;
    }
    final width = MediaQuery.sizeOf(context).width;
    final wideSidebar = width >= 768;
    final wideThread = width >= 1024;

    final sidebar = _Sidebar(
      chat: chat,
      channel: channel,
      thread: thread,
      onPick: () => setState(() => _drawer = false),
      onShow: _show,
      onNew: () => showNewChannelDialog(context),
    );
    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _header(channel, wideSidebar),
        _tabs(),
        if (_tab == _Tab.chat) ...[
          Expanded(
            child: MessageList(conversation: channel, filter: _search, emptyText: '#${channelName(channel)} 里还没人说话。跟管家说一件要做的事，比如「让测试小吴跑一遍测试」。'),
          ),
          ChatComposer(conversation: channel, placeholder: '发送消息至 #${channelName(channel)}'),
        ],
        if (_tab == _Tab.jobs)
          Expanded(
            child: channel == null ? const SizedBox() : _Jobs(channel: channel, onShow: _show),
          ),
        if (_tab == _Tab.schedules) Expanded(child: channel == null ? const SizedBox() : _Schedules(channel: channel)),
      ],
    );
    final pane = thread == null
        ? null
        : _ThreadPane(thread: thread, onClose: () => _show(channel != null && channel.kind != ConversationKind.general ? channel.id : null));

    return ProScope(
      child: ColoredBox(
        color: ProColor.page,
        child: Stack(
          children: [
            Positioned.fill(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (wideSidebar) SizedBox(width: 288, child: sidebar),
                  Expanded(child: main),
                  if (wideThread)
                    _Sliding(
                      from: _From.width,
                      child: pane == null
                          ? null
                          : Container(
                              width: 416,
                              decoration: const BoxDecoration(
                                color: ProColor.page,
                                border: Border(left: proLine),
                              ),
                              child: pane,
                            ),
                    ),
                ],
              ),
            ),
            if (!wideSidebar)
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: 288,
                child: _Sliding(from: _From.left, child: _drawer ? sidebar : null),
              ),
            if (!wideThread)
              Positioned.fill(
                child: _Sliding(
                  from: _From.right,
                  child: pane == null
                      ? null
                      : Container(
                          decoration: const BoxDecoration(
                            color: ProColor.page,
                            border: Border(left: proLine),
                          ),
                          child: pane,
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _header(Conversation? channel, bool wideSidebar) {
    final about = [
      if ((channel?.description ?? '').isNotEmpty) channel!.description!,
      if ((channel?.project ?? '').isNotEmpty) '默认项目 ${channel!.project}',
    ].join(' · ');
    final title = Text(channelName(channel), maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.lg);
    return Container(
      height: workbenchHead,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: const BoxDecoration(border: Border(bottom: proLine)),
      child: Row(
        children: [
          if (!wideSidebar) ...[
            ProButton.icon('icon-board', iconSize: 18, semanticLabel: '频道列表', onPressed: () => setState(() => _drawer = !_drawer)),
            const SizedBox(width: 12),
          ],
          Container(
            width: 32,
            height: 32,
            alignment: Alignment.center,
            decoration: const BoxDecoration(color: Palette.wheat, borderRadius: BorderRadius.all(Radius.circular(8))),
            child: const Text('#', style: ProText.lg),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (channel?.kind == ConversationKind.general) Tooltip(message: '默认的频道：你、管家和帮工都在这儿', child: title) else title,
                if (about.isNotEmpty) Text(about, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
              ],
            ),
          ),
          if (_search != null) ...[
            const SizedBox(width: 12),
            SizedBox(
              width: 192,
              child: CallbackShortcuts(
                bindings: {const SingleActivator(LogicalKeyboardKey.escape): () => setState(() => _search = null)},
                child: ProTextInput(
                  value: _search!,
                  autofocus: true,
                  onChanged: (v) => setState(() => _search = v),
                  placeholder: '在这个频道里找…',
                  icon: 'button-search',
                  semanticLabel: '找消息',
                ),
              ),
            ),
          ],
          const SizedBox(width: 12),
          ProButton.icon('act-search', iconSize: 18, semanticLabel: '找消息', onPressed: () => setState(() => _search = _search == null ? '' : null)),
          const SizedBox(width: 4),
          ProButton.icon(
            'icon-wrench',
            iconSize: 18,
            semanticLabel: '频道设置',
            onPressed: channel == null ? null : () => showChannelSettingsDialog(context, channel),
          ),
        ],
      ),
    );
  }

  Widget _tabs() => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12),
    decoration: const BoxDecoration(border: Border(bottom: proLine)),
    child: Semantics(
      label: '频道里的',
      container: true,
      child: Row(
        children: [
          _TabButton(on: _tab == _Tab.chat, icon: 'icon-board', label: '聊天', onTap: () => setState(() => _tab = _Tab.chat)),
          _TabButton(on: _tab == _Tab.jobs, icon: 'icon-tasks', label: '任务', onTap: () => setState(() => _tab = _Tab.jobs)),
          _TabButton(on: _tab == _Tab.schedules, icon: 'icon-clock', label: '定时', onTap: () => setState(() => _tab = _Tab.schedules)),
        ],
      ),
    ),
  );
}

class _TabButton extends StatelessWidget {
  const _TabButton({required this.on, required this.icon, required this.label, required this.onTap});
  final bool on;
  final String icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: on,
    builder: (context, s) => Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 6),
      margin: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: on ? ProColor.ink : const Color(0x00000000), width: 2)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Opacity(opacity: on || s.hovered ? 1 : .7, child: SpriteIcon(icon, size: 16)),
          const SizedBox(width: 6),
          ProWeightText(
            label,
            style: ProText.sm.copyWith(color: on || s.hovered ? ProColor.ink : ProColor.muted),
            strong: on,
          ),
        ],
      ),
    ),
  );
}

class _Sidebar extends ConsumerWidget {
  const _Sidebar({required this.chat, required this.channel, required this.thread, required this.onPick, required this.onShow, required this.onNew});
  final Chat? chat;
  final Conversation? channel;
  final Conversation? thread;
  final VoidCallback onPick;
  final void Function(String? id) onShow;
  final VoidCallback onNew;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channels = channelsOf(chat);
    final sessions = ref.watch(stateProvider)?.sessions ?? const <Session>[];
    return Semantics(
      label: '聊天',
      container: true,
      child: Container(
        decoration: const BoxDecoration(
          color: ProColor.side,
          border: Border(right: proLine),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              height: workbenchHead,
              padding: const EdgeInsets.symmetric(horizontal: 20),
              alignment: Alignment.centerLeft,
              decoration: const BoxDecoration(border: Border(bottom: proLine)),
              child: const Text('聊天', style: ProText.xl),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  _Section(
                    title: '频道',
                    count: channels.isEmpty ? 1 : channels.length,
                    action: ProButton.icon('button-add', semanticLabel: '创建频道', tooltip: '创建频道', onPressed: onNew),
                    children: [
                      // Before the first word the general is not there yet: it is still where you talk.
                      if (channels.isEmpty) const _ChannelRow(label: generalName, here: true, unread: 0, onTap: null),
                      for (final c in channels)
                        _ChannelRow(
                          label: channelName(c),
                          here: c.id == channel?.id,
                          unread: unreadUnder(chat, c),
                          onTap: () {
                            onShow(c.kind == ConversationKind.general ? null : c.id);
                            onPick();
                          },
                        ),
                    ],
                  ),
                  _Section(
                    title: '帮工',
                    count: sessions.length,
                    children: [
                      if (sessions.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 12),
                          child: Text('还没有帮工在地里：在频道里跟管家说一件活。', style: ProText.meta),
                        ),
                      for (final h in sessions)
                        _SessionRow(
                          session: h,
                          chat: chat,
                          active: thread?.id != null && jobThreadOf(chat, h)?.id == thread?.id,
                          onShow: (id) {
                            onShow(id);
                            onPick();
                          },
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const _ManagerLine(),
          ],
        ),
      ),
    );
  }
}

class _ChannelRow extends StatelessWidget {
  const _ChannelRow({required this.label, required this.here, required this.unread, required this.onTap});
  final String label;
  final bool here;
  final int unread;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    Widget row(TapState? s) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: here ? ProColor.selected : (s?.hovered ?? false ? ProColor.hover : null), borderRadius: proRadius),
      child: Row(
        children: [
          Text('#', style: ProText.sm.copyWith(color: ProColor.faint)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ProText.sm.copyWith(fontWeight: here || unread > 0 ? FontWeight.w600 : FontWeight.w400),
            ),
          ),
          if (unread > 0) ProCount(unread),
        ],
      ),
    );
    if (onTap == null) return row(null);
    return Tappable(onTap: onTap, selected: here, builder: (context, s) => row(s));
  }
}

class _Section extends StatefulWidget {
  const _Section({required this.title, required this.count, required this.children, this.action});
  final String title;
  final int count;
  final Widget? action;
  final List<Widget> children;

  @override
  State<_Section> createState() => _SectionState();
}

class _SectionState extends State<_Section> with SingleTickerProviderStateMixin {
  bool _open = true;

  /// Folded away, the rows are not built.
  late final _fold = AnimationController(vsync: this, value: 1)..addStatusListener((_) => setState(() {}));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _fold.duration = motionDuration(context, const Duration(milliseconds: 150));
  }

  @override
  void dispose() {
    _fold.dispose();
    super.dispose();
  }

  void _toggle() {
    setState(() => _open = !_open);
    if (_open) {
      _fold.forward();
    } else {
      _fold.reverse();
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
          child: Row(
            children: [
              Expanded(
                child: Tappable(
                  onTap: _toggle,
                  builder: (context, s) => Row(
                    children: [
                      AnimatedRotation(
                        turns: _open ? .25 : 0,
                        duration: motionDuration(context, const Duration(milliseconds: 150)),
                        child: const SpriteIcon('button-next', size: 12),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        widget.title,
                        style: ProText.xs.copyWith(fontWeight: FontWeight.w600, color: ProColor.muted),
                      ),
                      const SizedBox(width: 4),
                      Text('${widget.count}', style: ProText.meta.copyWith(color: ProColor.faint)),
                    ],
                  ),
                ),
              ),
              ?widget.action,
            ],
          ),
        ),
        if (!_fold.isDismissed)
          SizeTransition(
            sizeFactor: CurvedAnimation(parent: _fold, curve: Curves.easeOut),
            alignment: Alignment.topCenter,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (final c in widget.children) Padding(padding: const EdgeInsets.only(bottom: 4), child: c)],
            ),
          ),
      ],
    ),
  );
}

enum _From { width, left, right }

/// Null is no panel; a new panel while one is shown replaces it in place.
class _Sliding extends StatelessWidget {
  const _Sliding({required this.from, required this.child});
  final _From from;
  final Widget? child;

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
    duration: motionDuration(context, const Duration(milliseconds: 180)),
    switchInCurve: Curves.easeOut,
    switchOutCurve: Curves.easeIn,
    layoutBuilder: (current, previous) => Stack(children: [...previous, ?current]),
    transitionBuilder: (panel, t) => switch (from) {
      _From.width => SizeTransition(sizeFactor: t, axis: Axis.horizontal, alignment: Alignment.centerLeft, child: panel),
      _From.left => SlideTransition(
        position: Tween(begin: const Offset(-1, 0), end: Offset.zero).animate(t),
        child: panel,
      ),
      _From.right => SlideTransition(
        position: Tween(begin: const Offset(1, 0), end: Offset.zero).animate(t),
        child: panel,
      ),
    },
    child: child == null ? const SizedBox.shrink(key: ValueKey('none')) : KeyedSubtree(key: const ValueKey('panel'), child: child!),
  );
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.chat, required this.active, required this.onShow});
  final Session session;
  final Chat? chat;
  final bool active;
  final void Function(String id) onShow;

  @override
  Widget build(BuildContext context) {
    final h = session;
    final thread = jobThreadOf(chat, h);
    final unread = thread == null ? 0 : unreadIn(chat, thread);
    final phase = phaseText(h, nowMs());
    return Tappable(
      onTap: thread == null ? null : () => onShow(thread.id),
      tooltip: phase,
      builder: (context, s) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: active ? ProColor.selected : (s.hovered ? ProColor.hover : null), borderRadius: proRadius),
        child: Row(
          children: [
            SizedBox.square(
              dimension: 24,
              child: Stack(
                children: [
                  AgentHead(agent: h.agent, size: 24),
                  Positioned(right: -1, bottom: -1, child: ProDot(Color(phaseDot(h.phase)))),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(h.name, style: ProText.sm),
            const SizedBox(width: 8),
            PhaseGlyph(h.phase, size: 14),
            const SizedBox(width: 4),
            Expanded(
              child: Text(phase, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
            ),
            if (unread > 0) ProCount(unread),
          ],
        ),
      ),
    );
  }
}

const _mood = {ManagerState.idle: '在歇着', ManagerState.listening: '在听', ManagerState.thinking: '在想', ManagerState.speaking: '在说'};

class _ManagerLine extends ConsumerWidget {
  const _ManagerLine();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mood = ref.watch(stateProvider)?.manager ?? ManagerState.idle;
    final dot = switch (mood) {
      ManagerState.idle => Palette.cream300,
      ManagerState.thinking => Palette.wheat,
      _ => Palette.leaf500,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: const BoxDecoration(border: Border(top: proLine)),
      child: Row(
        children: [
          const ManagerHead(size: 32),
          const SizedBox(width: 8),
          const Text('管家', style: ProText.sm),
          const SizedBox(width: 8),
          ProDot(dot, size: 8),
          const SizedBox(width: 6),
          Text(_mood[mood]!, style: ProText.meta),
          if (mood == ManagerState.thinking) ...[const SizedBox(width: 6), const ThinkingDots()],
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text, {required this.icon});
  final String text;

  final String icon;

  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 384),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Opacity(opacity: .8, child: SpriteIcon(icon, size: 48)),
            const SizedBox(height: 12),
            Text(
              text,
              textAlign: TextAlign.center,
              style: ProText.sm.copyWith(color: ProColor.muted),
            ),
          ],
        ),
      ),
    ),
  );
}

BoxDecoration get _card =>
    const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: BorderRadius.all(Radius.circular(8)));

class _Jobs extends ConsumerWidget {
  const _Jobs({required this.channel, required this.onShow});
  final Conversation channel;
  final void Function(String? id) onShow;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final farm = ref.watch(stateProvider);
    final sessions = [...?farm?.sessions.where((h) => h.channel != null ? h.channel == channel.id : channel.kind == ConversationKind.general)];
    if (sessions.isEmpty) return const _Empty('这个频道里还没有活。在聊天里跟管家说一件要做的事，它会派帮工，活就列在这里。', icon: 'icon-tasks');
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final h in sessions)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(12),
            decoration: _card,
            child: Row(
              children: [
                AgentHead(agent: h.agent, size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: h.name,
                              style: const TextStyle(fontWeight: FontWeight.w600),
                            ),
                            TextSpan(text: '  @${h.id} ${h.project ?? ''}${h.branch != null ? ' · ${h.branch}' : ''}', style: ProText.meta),
                          ],
                        ),
                        style: ProText.sm,
                      ),
                      Text(h.brief, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.sm),
                      Row(
                        children: [
                          PhaseGlyph(h.phase, size: 14),
                          const SizedBox(width: 4),
                          Expanded(child: Text(phaseText(h, nowMs()), style: ProText.meta)),
                        ],
                      ),
                    ],
                  ),
                ),
                if (jobThreadOf(farm?.chat, h) case final thread?)
                  ProButton.text('工单串', icon: 'button-thread', size: ProSize.sm, onPressed: () => onShow(thread.id)),
              ],
            ),
          ),
      ],
    );
  }
}

class _Schedules extends ConsumerStatefulWidget {
  const _Schedules({required this.channel});
  final Conversation channel;

  @override
  ConsumerState<_Schedules> createState() => _SchedulesState();
}

class _SchedulesState extends ConsumerState<_Schedules> {
  String? _deleting;

  @override
  Widget build(BuildContext context) {
    final schedules = [...?ref.watch(stateProvider)?.schedules?.where((s) => s.channel == widget.channel.id)];
    if (schedules.isEmpty) return const _Empty('这个频道还没有定时。跟管家说「每天早上九点跑一遍测试」，它会定在这里；到点了频道里出现一条，再派活。', icon: 'icon-clock');
    final actions = ref.read(chatActionsProvider);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final s in schedules)
          Opacity(
            opacity: s.enabled || s.pending == true ? 1 : .6,
            child: Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.all(12),
              decoration: _card,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SpriteIcon('icon-clock', size: 20),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: s.name,
                                style: const TextStyle(fontWeight: FontWeight.w600),
                              ),
                              TextSpan(
                                text:
                                    '  ${s.whenText ?? ''} · ${s.pending == true ? s.nextText ?? '' : '下次 ${s.nextText ?? ''}'}'
                                    '${s.agent != null ? ' · 直接派 ${s.agent}' : ''}${s.by == ScheduleBy.manager ? ' · 管家定的' : ''}',
                                style: ProText.meta,
                              ),
                            ],
                          ),
                          style: ProText.sm,
                        ),
                        Text(s.text, style: ProText.sm),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  if (s.pending == true) ...[
                    ProButton(
                      size: ProSize.sm,
                      tone: ProTone.accent,
                      semanticLabel: '同意定时「${s.name}」',
                      onPressed: () => unawaited(actions.setScheduleEnabled(s.id, true).catchError((Object _) {})),
                      child: const Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon('mark-check', size: 16), SizedBox(width: 4), Text('同意')]),
                    ),
                    const SizedBox(width: 12),
                    ProButton(
                      size: ProSize.sm,
                      semanticLabel: '不要定时「${s.name}」',
                      onPressed: () => unawaited(actions.removeSchedule(s.id).catchError((Object _) {})),
                      child: const Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon('mark-cross', size: 16), SizedBox(width: 4), Text('不要')]),
                    ),
                  ] else ...[
                    ProButton.text(
                      s.enabled ? '开着' : '关着',
                      size: ProSize.sm,
                      tone: s.enabled ? ProTone.accent : ProTone.plain,
                      onPressed: () => unawaited(actions.setScheduleEnabled(s.id, !s.enabled).catchError((Object _) {})),
                    ),
                    const SizedBox(width: 12),
                    TapRegion(
                      onTapOutside: (_) {
                        if (_deleting == s.id) setState(() => _deleting = null);
                      },
                      child: ProButton(
                        size: ProSize.sm,
                        tooltip: _deleting == s.id ? null : '删掉',
                        semanticLabel: _deleting == s.id ? '确定删？' : '删掉定时「${s.name}」',
                        child: _deleting == s.id ? const Text('确定删？') : const SpriteIcon('button-delete', size: 16),
                        onPressed: () {
                          if (_deleting == s.id) {
                            unawaited(actions.removeSchedule(s.id).catchError((Object _) {}));
                          } else {
                            setState(() => _deleting = s.id);
                          }
                        },
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _ThreadPane extends ConsumerWidget {
  const _ThreadPane({required this.thread, required this.onClose});
  final Conversation thread;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final farm = ref.watch(stateProvider);
    final sessions = farm?.sessions ?? const <Session>[];
    final session = threadOwnerOf(thread, sessions);
    final status = session != null
        ? '@${session.id} · ${phaseText(session, nowMs())}'
        : thread.subjectKind == SubjectKind.issue
        ? '现在没有帮工在干，串还留着'
        : '${idText(thread.replies)} 条回复';
    return Semantics(
      label: '串',
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: workbenchHead,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: const BoxDecoration(border: Border(bottom: proLine)),
            child: Row(
              children: [
                SizedBox.square(
                  dimension: 32,
                  child: Center(child: session != null ? AgentHead(agent: session.agent, size: 32) : const Glyph('button-thread')),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        threadTitle(farm?.chat, thread, issues: farm?.issues ?? const [], sessions: sessions),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ProText.sm.copyWith(fontWeight: FontWeight.w600),
                      ),
                      Row(
                        children: [
                          if (session != null) ...[PhaseGlyph(session.phase, size: 14), const SizedBox(width: 4)],
                          Flexible(
                            child: Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                ProButton.icon('button-close', semanticLabel: '关上串', onPressed: onClose),
              ],
            ),
          ),
          Expanded(
            child: MessageList(conversation: thread, emptyText: '串里还没人说话。在这里说的话，它的帮工会看到。'),
          ),
          ChatComposer(conversation: thread, placeholder: session != null ? '在串里说，${session.name}会看到' : '回复这个串'),
        ],
      ),
    );
  }
}
