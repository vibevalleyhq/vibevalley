import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../chat/chat_state.dart' show chatActionsProvider, chatOpenProvider;
import '../data/remote.dart' show workStepsProvider;
import '../shared/work_log.dart' show WorkLog;
import '../game/commands.dart';
import '../game/tools.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import '../rules/chat.dart';
import '../rules/sessions.dart';
import '../rules/cast.dart';
import '../rules/playbook.dart';
import '../rules/seeds.dart';
import '../shared/swatches.dart';
import '../shared/tags.dart';
import '../rules/money.dart';

class PlotDetail extends ConsumerStatefulWidget {
  const PlotDetail({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;

  @override
  ConsumerState<PlotDetail> createState() => _PlotDetailState();
}

class _PlotDetailState extends ConsumerState<PlotDetail> {
  var _text = '';

  @override
  void initState() {
    super.initState();
    // The server keeps every step: loaded in full when the panel opens, kept up by step events.
    ref.read(workStepsProvider.notifier).load(widget.session.id).then((_) {}, onError: (Object _) {});
  }

  void _send() {
    if (_text.trim().isEmpty) return;
    fire(ref.read(farmCommandsProvider).water(widget.session, _text));
    setState(() => _text = '');
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    final atlas = ref.watch(atlasProvider).value;
    final agent = (ref.watch(agentsProvider).value ?? const <String, Agent>{})[session.agent];
    final view = ref.watch(viewProvider);
    final plot = view == null ? const PlotView(crop: Crop.empty) : plotOf(view, session);
    final cast = castOf(agent?.look, session.agent);
    final log = ref.watch(workStepsProvider.select((all) => all[session.id]));
    final hasThread = ref.watch(stateProvider.select((s) => jobThreadOf(s?.chat, session.id)?.id));
    final station = stationOfSession(session);
    final working = isBusy(session);
    final current = doingOf(session);
    final conflict = canHarvest(session) ? session.conflict : null;
    final phase = session.phase;
    final quiet = phase is PhaseWorking && phase.quietSince != null;
    final retrying = phase is PhaseWorking && phase.retry != null;
    final play = session.play;
    final history = (play?.history ?? const <ActionStep>[]);
    final steps = history.sublist(history.length > 12 ? history.length - 12 : 0).reversed.toList();
    final commands = ref.read(farmCommandsProvider);
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    final aside = Container(
      width: 208,
      color: Palette.cream100,
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          SizedBox(
            height: 176,
            child: Stack(
              alignment: Alignment.bottomCenter,
              children: [
                if (atlas != null && atlas.has(cropSprite(plot.crop)))
                  Positioned(bottom: 0, child: Opacity(opacity: .9, child: _Sprite(atlas[cropSprite(plot.crop)], width: 176))),
                if (atlas != null) _Sprite(atlas['${lookOf(agent, session.agent, atlas.has)}-down'], height: 144),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(cropLabel[plot.crop]!, style: KitText.sm),
          Text('${speciesLabel[cast.species]} · ${outfitLabel[cast.outfit]} · ${runtimeName(session.runtime)}', textAlign: TextAlign.center, style: xs),
          if (agent != null && agent.model.isNotEmpty) Text(agent.model, style: xs),
          Text('第 ${station + 1} 块地 · 第 ${session.runs.round()} 轮', style: xs),
          if (session.spent != null) Text('花了 ${spentText(session.spent!)}', style: xs),
          const SizedBox(height: 8),
          _Link('看${agent?.name ?? '它'}的档案', onTap: () => context.go('/agents/${Uri.encodeComponent(session.agent)}')),
        ],
      ),
    );
    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (session.project != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Tinted(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      KitTappable(
                        onTap: () => context.go('/projects/${Uri.encodeComponent(session.project!)}'),
                        tooltip: '看这个项目：种了什么、一年的耕作日历',
                        builder: (context, s) => FarmTag(
                          '项目 ${session.project}',
                          fill: s.hovered ? const Color(0xFFB6844E) : const Color(0xFFA5743F),
                          ink: Palette.cream50,
                          goes: true,
                        ),
                      ),
                      if (session.branch != null) FarmTag(session.branch!, ink: Palette.bark800),
                      Text('收获时这条分支会合进项目', style: KitText.xs.copyWith(color: Palette.bark400)),
                      KitTappable(
                        onTap: () => context.go('/issues/${Uri.encodeComponent(session.id)}'),
                        tooltip: '这块地上的这次种植，在工单看板上：几轮、用时、改动',
                        builder: (context, s) => FarmTag('在看板上看', fill: s.hovered ? Palette.cream300 : Palette.cream200, ink: Palette.bark800, goes: true),
                      ),
                    ],
                  ),
                  if (session.worktree != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(
                        children: [
                          Text('worktree', style: xs),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Tooltip(
                              message: session.worktree!,
                              child: Text(
                                session.worktree!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: KitText.mono.copyWith(color: Palette.bark800),
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          KitTappable(
                            onTap: () => Clipboard.setData(ClipboardData(text: session.worktree ?? '')),
                            builder: (context, s) =>
                                FarmTag('复制路径', fill: s.hovered ? Palette.cream300 : Palette.cream200, ink: Palette.bark800, icon: 'button-copy'),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        if (session.playbook != null) PlanLine(session: session, onDone: widget.onDone),
        Text(session.task, style: KitText.sm),
        if (current.action != SessionAction.none)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.leaf300, .4),
              child: Row(
                children: [
                  ActionGlyph(current.action, size: 22),
                  const SizedBox(width: 8),
                  Text('正在${actionText[current.action]}', style: KitText.sm),
                  if (current.label.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Flexible(
                      child: Container(
                        color: Palette.cream50,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        child: Text(current.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.mono),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        if (quiet || retrying)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.water, .15),
              child: Ticking(
                builder: (context, now) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(phaseText(session, now), style: KitText.sm),
                    if (quiet) Text('可能在跑很久的命令，也可能卡住了：看看下面的干活过程，不对就叫停。', style: xs),
                  ],
                ),
              ),
            ),
          ),
        if (conflict != null && !working)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.berry, .12),
              child: Row(
                children: [
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: '合进 ${conflict.base} 会冲突：',
                            style: const TextStyle(color: Palette.berry),
                          ),
                          TextSpan(text: conflict.files.join('、'), style: KitText.mono),
                        ],
                      ),
                      style: KitText.sm,
                    ),
                  ),
                  const SizedBox(width: 8),
                  PxButton.text('让它解决冲突', tone: PxTone.danger, onPressed: () => fire(commands.resolve(session))),
                ],
              ),
            ),
          ),
        if (session.lastRun != null && !working)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: session.lastRun!.outcome == Outcome.failed ? tint(Palette.berry, .12) : tint(Palette.wheat, .2),
              child: Text(
                '${outcomeLabel[session.lastRun!.outcome]}：${session.lastRun!.summary}',
                style: KitText.sm.copyWith(color: session.lastRun!.outcome == Outcome.failed ? Palette.berry : Palette.bark900),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (plot.crop == Crop.withered) PxButton.text('杀虫：接着修', tone: PxTone.danger, onPressed: () => fire(commands.cure(session))),
            if (canHarvest(session) && session.playbook == null)
              PxButton.text(
                '收获…',
                tone: PxTone.primary,
                onPressed: () {
                  ref.read(reviewingProvider.notifier).set(session.id);
                  widget.onDone();
                },
              ),
            if (session.phase is PhaseWorking) PxButton.text('叫停', onPressed: () => fire(commands.stop(session.id))),
            if (hasThread != null)
              PxButton.text(
                '看工单串',
                onPressed: () {
                  fire(ref.read(chatActionsProvider).showJobThread(session.id));
                  ref.read(chatOpenProvider.notifier).set(true);
                  widget.onDone();
                },
              ),
            PxButton.text(
              '请它收工',
              onPressed: () {
                fire(commands.dismiss(session.id));
                widget.onDone();
              },
            ),
          ],
        ),
        const SizedBox(height: 12),
        Container(
          color: Palette.cream100,
          padding: const EdgeInsets.fromLTRB(6, 4, 4, 4),
          child: Row(
            children: [
              const SpriteIcon('icon-water', size: 28),
              const SizedBox(width: 6),
              Expanded(
                child: PxTextInput(
                  value: _text,
                  onChanged: (v) => setState(() => _text = v),
                  onSubmitted: (_) => _send(),
                  placeholder: session.phase is PhaseWorking ? '浇水：干着活也能收到这句话' : '浇水：带句话，它会接着干',
                  semanticLabel: '给${session.name}带句话',
                ),
              ),
              const SizedBox(width: 8),
              PxButton.text('浇水', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : _send),
            ],
          ),
        ),
        if (log != null && log.isNotEmpty)
          FarmSection(
            title: '干活过程',
            child: Ticking(
              builder: (context, now) => WorkLog(
                steps: log,
                now: now,
                working: session.phase is PhaseWorking,
                onComment: (step, text) => ref.read(farmCommandsProvider).water(session, text, on: step),
              ),
            ),
          )
        else
          FarmSection(
            title: '这一轮做了什么',
            child: steps.isEmpty
                ? Text('还没动手。', style: KitText.sm.copyWith(color: Palette.bark600))
                : Ticking(
                    builder: (context, now) => Column(
                      children: [
                        for (final s in steps)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Row(
                              children: [
                                ActionGlyph(s.action, size: 18),
                                const SizedBox(width: 8),
                                SizedBox(
                                  width: 56,
                                  child: Text(actionText[s.action]!, style: KitText.sm.copyWith(color: Palette.bark800)),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    s.label,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: KitText.mono.copyWith(color: Palette.bark600),
                                  ),
                                ),
                                Text(ago(s.at, now), style: KitText.xs.copyWith(color: Palette.bark400)),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
          ),
        if ((play?.files ?? const []).isNotEmpty)
          FarmSection(
            title: '碰过的文件',
            child: Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final f in _last(play!.files, 10))
                  Container(
                    color: Palette.cream200,
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    child: Text(f, style: KitText.mono.copyWith(color: Palette.bark800)),
                  ),
              ],
            ),
          ),
        if ((play?.commands ?? const []).isNotEmpty)
          FarmSection(
            title: '跑过的命令',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final c in _last(play!.commands, 5))
                  Text(
                    '\$ $c',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.mono.copyWith(color: Palette.bark800),
                  ),
              ],
            ),
          ),
      ],
    );
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth >= 560
          ? Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                aside,
                const SizedBox(width: 16),
                Expanded(child: main),
              ],
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [aside, const SizedBox(height: 16), main]),
    );
  }
}

class _Sprite extends StatelessWidget {
  const _Sprite(this.sprite, {this.width, this.height});
  final SpriteInfo sprite;
  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context) => Image.asset(
    sprite.asset,
    width: width ?? (height! * sprite.w / sprite.h),
    height: height ?? (width! * sprite.h / sprite.w),
    fit: BoxFit.contain,
    filterQuality: FilterQuality.none,
  );
}

class _Link extends StatelessWidget {
  const _Link(this.text, {required this.onTap});
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    builder: (context, s) => Text(
      text,
      style: KitText.xs.copyWith(color: Palette.leaf700, decoration: s.hovered || s.focused ? TextDecoration.underline : null),
    ),
  );
}

class PlanLine extends ConsumerWidget {
  const PlanLine({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tag = session.playbook;
    final pb = tag == null ? null : playbookOf(ref.watch(plansProvider), tag.id);
    if (tag == null || pb == null) return const SizedBox.shrink();
    final node = tag.node == null ? null : nodeOf(pb, tag.node!);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Tinted(
        color: tint(Palette.wheat, .25),
        child: Row(
          children: [
            Expanded(
              child: node != null
                  ? Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: '种植计划「${pb.title}」的一步：'),
                          TextSpan(text: node.title),
                          const TextSpan(text: '。做完自动合进计划分支，收获整个计划时才进主分支。'),
                        ],
                      ),
                      style: KitText.xs,
                    )
                  : Text('在拆种植计划「${pb.title}」：只读代码，不改文件。', style: KitText.xs),
            ),
            const SizedBox(width: 8),
            KitTappable(
              onTap: () {
                ref.read(planShownProvider.notifier).set(pb.id);
                ref.read(panelProvider.notifier).set(FarmPanel.plans);
                onDone();
              },
              builder: (context, s) => FarmTag('看计划', fill: s.hovered ? Palette.cream100 : Palette.cream50, ink: Palette.leaf700),
            ),
          ],
        ),
      ),
    );
  }
}

List<String> _last(List<String> all, int n) => all.length > n ? all.sublist(all.length - n) : all;
