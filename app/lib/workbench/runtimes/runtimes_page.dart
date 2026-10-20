import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../rules/time.dart';
import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import '../../ui/pro/pro.dart';
import '../../shared/faces.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import '../shared/layout.dart';
import 'runtimes_state.dart';
import '../../rules/money.dart';

class RuntimesPage extends ConsumerWidget {
  const RuntimesPage({super.key, this.id});
  final String? id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(workbenchConfigProvider);
    if (ref.watch(runtimesProvider).hasError) return const RuntimeProblem();
    final busy = ref.watch(runtimeBusyProvider);
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return const SizedBox.shrink();
    final runtimes = ref.watch(runtimesProvider).value ?? const <RuntimeInfo>[];
    final selected = runtimes.where((r) => r.id == id).firstOrNull ?? runtimes.firstOrNull;
    return ListDetail(
      opened: id != null,
      detailMaxWidth: 896,
      detailScrolls: true,
      list: ListCard(
        title: '农具',
        subtitle: '机器上的编码 agent',
        semanticLabel: '农具列表',
        children: [for (final r in runtimes) _ListItem(runtime: r, config: config, active: selected?.id == r.id)],
      ),
      detail: selected == null
          ? [
              Padding(
                padding: const EdgeInsets.all(32),
                child: Text('读取中…', style: ProText.sm.copyWith(color: ProColor.muted)),
              ),
            ]
          : _detail(atlas, selected, config, busy[selected.id]),
    );
  }
}

class _ListItem extends StatelessWidget {
  const _ListItem({required this.runtime, required this.config, required this.active});
  final RuntimeInfo runtime;
  final WorkbenchConfig config;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final r = runtime;
    final preset = r.preset;
    final ok = r.installation is InstallationAvailable;
    final using = config.agents.where((a) => a.runtime == r.id).length;
    final status = switch (r.installation) {
      InstallationAvailable(:final version) => r.settings.enabled ? (version ?? '可用') : '已停用',
      // The reason, not just 不支持: for vibevalley it is a missing DeepSeek key, which is the owner's to fix.
      InstallationUnsupported(:final reason) => reason.isEmpty ? '不支持' : reason,
      InstallationNotFound() => '没找到',
      InstallationChecking() => '检测中…',
    };
    return ListRow(
      active: active,
      onTap: () => workbenchGo(context, '/runtimes/${r.id}'),
      child: Row(
        children: [
          RuntimeIcon(runtime: r.id, size: 36, muted: !ok),
          const SizedBox(width: 10),
          Expanded(
            child: RowText(preset.label, '$status${using > 0 ? ' · $using 个 agent' : ''}', extra: ok ? _ListStamina(info: r) : null),
          ),
          const SizedBox(width: 10),
          StateDot(ok ? (r.settings.enabled ? Palette.leaf500 : ProColor.faint) : Palette.berry),
        ],
      ),
    );
  }
}

class _ListStamina extends StatelessWidget {
  const _ListStamina({required this.info});
  final RuntimeInfo info;

  @override
  Widget build(BuildContext context) {
    final quota = quotaOf(info);
    if (quota.level == QuotaLevel.unknown) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          StaminaBar(quota: quota, segments: 10, width: 92, height: 7),
          const SizedBox(width: 6),
          Text(quota.short, style: ProText.xs.copyWith(color: quota.level == QuotaLevel.empty ? Palette.berry : ProColor.muted)),
        ],
      ),
    );
  }
}

List<Widget> _detail(SpriteAtlas atlas, RuntimeInfo info, WorkbenchConfig config, RuntimeBusy? busy) {
  final facts = info.facts;
  final agents = config.agents.where((a) => a.runtime == info.id).toList();
  return [
    _Header(info: info, busy: busy),
    Cols(
      columns: 2,
      stretch: true,
      children: [
        ProCard(
          title: '账户',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [RuntimeUsage(atlas: atlas, info: info)],
          ),
        ),
        _FactsCard(facts: facts),
      ],
    ),
    _SettingsCard(key: ValueKey('settings-${info.id}'), info: info),
    _ModelsCard(info: info),
    Cols(
      columns: 3,
      stretch: true,
      children: [
        _InventoryCard(title: '技能', entries: info.skills),
        _InventoryCard(title: 'MCP 服务器', entries: info.mcpServers),
        _InventoryCard(title: '工具', entries: info.tools),
      ],
    ),
    _AgentsCard(runtime: info.id, agents: agents),
  ];
}

Color _hex(String css) => Color(int.parse('ff${css.replaceFirst('#', '')}', radix: 16));

class _Header extends ConsumerWidget {
  const _Header({required this.info, required this.busy});
  final RuntimeInfo info;
  final RuntimeBusy? busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final preset = info.preset;
    final inst = info.installation;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
      child: Row(
        children: [
          Container(
            width: 72,
            height: 72,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: const Border.fromBorderSide(proLine),
              gradient: RadialGradient(center: const Alignment(0, .4), radius: .7, colors: [_hex(preset.look.hat).withValues(alpha: .2), ProColor.page]),
            ),
            child: RuntimeIcon(runtime: info.id, size: 60, muted: inst is! InstallationAvailable),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(preset.label, style: ProText.xl),
                Text(preset.blurb, style: ProText.sm.copyWith(color: ProColor.muted)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    ...switch (inst) {
                      InstallationAvailable(:final version, :final command, :final via) => [
                        TintTag('可用 ${version ?? ''}', fill: okTag.fill, ink: okTag.ink),
                        Text(command, style: ProText.mono.copyWith(color: ProColor.muted)),
                        Text(via == Via.bundled ? '随 oar 一起装' : '命令行', style: ProText.meta),
                      ],
                      InstallationUnsupported(:final reason) => [TintTag('不支持：$reason', fill: badTag.fill, ink: badTag.ink)],
                      InstallationNotFound() => [TintTag('这台机器上没找到', fill: badTag.fill, ink: badTag.ink)],
                      InstallationChecking() => [Text('检测中…', style: ProText.meta)],
                    },
                    if (inst is! InstallationChecking) Text('检测于 ${wallClockText(info.checkedAt)}', style: ProText.meta),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              ProButton.text(
                busy == RuntimeBusy.refreshing ? '检测中…' : '重新检测',
                onPressed: busy != null ? null : () => ref.read(runtimeBusyProvider.notifier).refresh(info.id),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FactsCard extends StatelessWidget {
  const _FactsCard({required this.facts});
  final RuntimeFacts facts;

  @override
  Widget build(BuildContext context) {
    const small = ProText.sm;
    final heading = ProText.meta.copyWith(fontWeight: FontWeight.w500);
    return ProCard(
      title: '能做什么',
      aside: const Text('来自 oar 0.44'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Marked(facts.steer ? 'mark-check' : 'mark-cross', top: 4, child: Text(facts.steer ? '干活时能接话（steer）' : '干活时不能插话，话会排到这一轮之后', style: small)),
          const SizedBox(height: 6),
          Text(facts.inProcess ? '· 跑在 server 进程里（Node SDK）' : '· 作为单独的命令行进程运行', style: small),
          const SizedBox(height: 12),
          Text('不接受的开 session 参数', style: heading),
          const SizedBox(height: 6),
          if (facts.refused.isEmpty)
            Text('都接受。', style: small)
          else
            for (final MapEntry(:key, :value) in facts.refused.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(text: key, style: ProText.mono),
                      TextSpan(text: ' $value', style: ProText.meta),
                    ],
                  ),
                ),
              ),
          const SizedBox(height: 12),
          Text('oar 提供的查询', style: heading),
          const SizedBox(height: 6),
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              for (final c in RuntimeCapability.values)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: facts.capabilities.contains(c) ? ProColor.selected : null,
                    border: facts.capabilities.contains(c) ? Border.all(color: const Color(0x00000000)) : const Border.fromBorderSide(proLine),
                    borderRadius: const BorderRadius.all(Radius.circular(4)),
                  ),
                  child: Text(
                    _capabilityLabel(c),
                    style: ProText.xs.copyWith(
                      color: facts.capabilities.contains(c) ? ProColor.ink : ProColor.muted,
                      decoration: facts.capabilities.contains(c) ? null : TextDecoration.lineThrough,
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

RuntimeSettings _with(
  RuntimeSettings s, {
  bool? enabled,
  String? binPath,
  String? defaultModel,
  String? defaultEffort,
  Map<String, String>? env,
  (double?,)? dailyBudget,
  (double?,)? maxWorking,
}) => RuntimeSettings(
  enabled: enabled ?? s.enabled,
  binPath: binPath ?? s.binPath,
  defaultModel: defaultModel ?? s.defaultModel,
  defaultEffort: defaultEffort ?? s.defaultEffort,
  env: env ?? s.env,
  dailyBudget: dailyBudget != null ? dailyBudget.$1 : s.dailyBudget,
  maxWorking: maxWorking != null ? maxWorking.$1 : s.maxWorking,
);

String _json(RuntimeSettings s) => jsonEncode(s.toJson());

class _SettingsCard extends ConsumerStatefulWidget {
  const _SettingsCard({super.key, required this.info});
  final RuntimeInfo info;

  @override
  ConsumerState<_SettingsCard> createState() => _SettingsCardState();
}

class _SettingsCardState extends ConsumerState<_SettingsCard> {
  late RuntimeSettings _draft = widget.info.settings;

  @override
  void didUpdateWidget(_SettingsCard old) {
    super.didUpdateWidget(old);
    // The settings as the server has them now replace the draft.
    if (_json(old.info.settings) != _json(widget.info.settings)) _draft = widget.info.settings;
  }

  void _set(RuntimeSettings next) => setState(() => _draft = next);

  @override
  Widget build(BuildContext context) {
    final info = widget.info;
    final dirty = _json(_draft) != _json(info.settings);
    final models = info.models ?? const <ModelEntry>[];
    final wanted = _draft.defaultModel.isNotEmpty ? _draft.defaultModel : models.where((m) => m.isDefault).firstOrNull?.id;
    final model = models.where((m) => m.id == wanted).firstOrNull;
    final facts = info.facts;
    final refusedEffort = facts.refused[sessionEffort];
    final refusedEnv = facts.refused[sessionEnv];
    final envVar = 'OAR_${info.id.toUpperCase()}_BIN';
    final effortHint = refusedEffort ?? ((model?.effortLevels.isNotEmpty ?? false) ? null : '这个模型没有推理强度可选。');
    return ProCard(
      title: '设置',
      aside: dirty
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ProButton.text('放弃', onPressed: () => setState(() => _draft = info.settings)),
                const SizedBox(width: 8),
                ProButton.text('保存', tone: ProTone.primary, onPressed: () => ref.read(runtimeBusyProvider.notifier).update(info.id, _draft)),
              ],
            )
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Cols(
            columns: 2,
            stretch: true,
            children: [
              ProSwitchField(
                label: '让 agent 用它',
                checked: _draft.enabled,
                onChanged: (enabled) => _set(_with(_draft, enabled: enabled)),
                hint: '停用后，用它的 agent 都派不出去。',
              ),
              ProField(
                label: '命令路径',
                hint: Text('对应 oar 的 $envVar。留空就在 PATH 里找。'),
                child: ProTextInput(
                  value: _draft.binPath,
                  onChanged: (binPath) => _set(_with(_draft, binPath: binPath)),
                  placeholder: '自动查找',
                  mono: true,
                  semanticLabel: '命令路径',
                ),
              ),
              ProField(
                label: '默认模型',
                hint: const Text('agent 没指定模型时用它。'),
                child: ProPick(
                  value: _draft.defaultModel,
                  onChanged: (defaultModel) => _set(_with(_draft, defaultModel: defaultModel, defaultEffort: '')),
                  placeholder: 'runtime 自己的默认',
                  options: [for (final m in models) PickOption(value: m.id, label: m.name)],
                  enabled: models.isNotEmpty,
                  semanticLabel: '默认模型',
                ),
              ),
              ProField(
                label: '默认推理强度',
                hint: effortHint == null ? null : Text(effortHint),
                child: ProSegmented<String>(
                  value: _draft.defaultEffort,
                  onChanged: (defaultEffort) => _set(_with(_draft, defaultEffort: defaultEffort)),
                  options: [
                    const SegmentOption(value: '', label: '默认'),
                    for (final l in model?.effortLevels ?? const <String>[]) SegmentOption(value: l, label: l, disabled: refusedEffort != null),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Cols(
            columns: 2,
            children: [
              ProField(
                label: '最多同时干活',
                hint: const Text('用它的帮工同时干活的上限，服务商限并发时有用。到了上限，新活派不出去，等有人干完。留空只受农场自己的上限（6 块地）。'),
                child: NumberInput(
                  value: _draft.maxWorking,
                  onChanged: (maxWorking) => _set(_with(_draft, maxWorking: (maxWorking,))),
                  placeholder: '不另设',
                  semanticLabel: '最多同时干活',
                ),
              ),
              if (info.id == 'pi' || info.id == 'vibevalley')
                ProField(
                  label: '每日预算（元）',
                  hint: Text('今天已经花了 ${yuan(info.spentToday ?? 0)}（按${info.id == 'pi' ? ' pi 的' : '模型的'}价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。'),
                  child: NumberInput(
                    value: _draft.dailyBudget,
                    onChanged: (dailyBudget) => _set(_with(_draft, dailyBudget: (dailyBudget,))),
                    placeholder: '不设上限',
                    semanticLabel: '每日预算',
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          ProField(
            label: '环境变量',
            hint: Text(refusedEnv ?? '叠加到这个 runtime 的每个 session 上；agent 自己的环境变量优先。'),
            child: ProKeyValueEditor(
              value: _draft.env,
              onChanged: (env) => _set(_with(_draft, env: env)),
              enabled: refusedEnv == null,
            ),
          ),
        ],
      ),
    );
  }
}

/// The text is kept as typed, the number follows it (empty or 0 means none).
class NumberInput extends StatefulWidget {
  const NumberInput({super.key, required this.value, required this.onChanged, required this.placeholder, required this.semanticLabel});
  final double? value;
  final ValueChanged<double?> onChanged;
  final String placeholder;
  final String semanticLabel;

  @override
  State<NumberInput> createState() => _NumberInputState();
}

String _numText(double? v) => v == null || v == 0 ? '' : (v == v.roundToDouble() ? v.toInt().toString() : v.toString());

class _NumberInputState extends State<NumberInput> {
  late String _text = _numText(widget.value);

  @override
  void didUpdateWidget(NumberInput old) {
    super.didUpdateWidget(old);
    if ((double.tryParse(_text) ?? 0) != (widget.value ?? 0)) _text = _numText(widget.value);
  }

  @override
  Widget build(BuildContext context) => ProTextInput(
    value: _text,
    onChanged: (t) {
      setState(() => _text = t);
      final n = double.tryParse(t.trim());
      widget.onChanged(t.trim().isNotEmpty && n != null && n.isFinite && n > 0 ? n : null);
    },
    placeholder: widget.placeholder,
    mono: true,
    semanticLabel: widget.semanticLabel,
  );
}

class RuntimeUsage extends StatelessWidget {
  const RuntimeUsage({super.key, required this.atlas, required this.info});
  final SpriteAtlas atlas;
  final RuntimeInfo info;

  @override
  Widget build(BuildContext context) {
    final muted = ProText.meta;
    final usage = info.usage;
    switch (usage) {
      case null:
        return Text(info.facts.capabilities.contains(RuntimeCapability.accountUsage) ? '装好以后才能读到。' : '这个 runtime 不报告账户用量。', style: muted);
      case AccountUsageLoginRequired():
        return Text('没登录。在这台机器上运行 ${info.preset.label} 登录一次。', style: ProText.xs.copyWith(color: const Color(0xFFB8682A)));
      case AccountUsageUnavailable(:final reason):
        return Text('读不到：$reason', style: muted);
      case AccountUsageBalance() || AccountUsageOk():
    }
    final quota = quotaOf(info);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 56,
          child: Column(
            children: [
              EnergyBottle(atlas: atlas, quota: quota, size: 52),
              Text(quota.short.isEmpty ? '—' : quota.short, style: ProText.sm),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: switch (usage) {
              AccountUsageBalance(:final provider, :final available) => [
                Text('按量计费，这里是 $provider 账户余额${available ? '。' : '，不够用了。'}', style: ProText.sm.copyWith(color: available ? ProColor.ink : Palette.berry)),
                const SizedBox(height: 10),
                Text(
                  '今天帮工花了约 ${yuan(info.spentToday ?? 0)}${(info.settings.dailyBudget ?? 0) > 0 ? '，每日预算 ${yuan(info.settings.dailyBudget!)}' : '，没设每日预算'}。',
                  style: ProText.sm.copyWith(color: ProColor.muted),
                ),
              ],
              AccountUsageOk(:final subscription, :final windows) => [
                if (subscription != null && subscription.isNotEmpty) Text('套餐：$subscription', style: ProText.sm.copyWith(color: ProColor.muted)),
                for (final w in windows) _Window(window: w),
              ].indexed.expand((e) => [if (e.$1 > 0) const SizedBox(height: 10), e.$2]).toList(),
              _ => const <Widget>[],
            },
          ),
        ),
      ],
    );
  }
}

String _pct(double n) => n == n.roundToDouble() ? n.toInt().toString() : n.toString();

class _Window extends StatelessWidget {
  const _Window({required this.window});
  final UsageWindow window;

  @override
  Widget build(BuildContext context) {
    final left = 100 - window.usedPercent;
    final label = windowLabel(window.label);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(child: Text(label, style: ProText.meta)),
            Text('剩 ${_pct(left)}%', style: ProText.xs),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6, bottom: 2),
          child: Align(
            alignment: Alignment.centerLeft,
            child: StaminaBar(
              quota: Quota(level: levelOf(left), fill: left / 100, short: '${_pct(left)}%', text: '$label 剩 ${_pct(left)}%'),
              width: 220,
              height: 10,
            ),
          ),
        ),
        if (window.resetsAt case final at?)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('${momentText(at)} 重置', style: ProText.meta),
          ),
      ],
    );
  }
}

class _ModelsCard extends StatelessWidget {
  const _ModelsCard({required this.info});
  final RuntimeInfo info;

  @override
  Widget build(BuildContext context) {
    final models = info.models;
    final head = ProText.meta.copyWith(fontWeight: FontWeight.w500);
    return ProCard(
      title: '模型',
      aside: models == null ? null : Text('${models.length} 个'),
      child: models == null
          ? Text(info.installation is InstallationAvailable ? '这个 runtime 不报告模型列表。' : '装好以后才能读到。', style: head)
          : Table(
              columnWidths: const {0: FlexColumnWidth(), 1: FlexColumnWidth()},
              defaultVerticalAlignment: TableCellVerticalAlignment.middle,
              children: [
                TableRow(
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text('模型', style: head),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text('推理强度', style: head),
                    ),
                  ],
                ),
                for (final m in models)
                  TableRow(
                    decoration: const BoxDecoration(border: Border(top: proLine)),
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Wrap(
                          spacing: 8,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(m.id, style: ProText.mono),
                            if (m.isDefault) TintTag('默认', fill: okTag.fill, ink: okTag.ink),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Text(m.effortLevels.isEmpty ? '—' : m.effortLevels.join(' · '), style: ProText.sm.copyWith(color: ProColor.muted)),
                      ),
                    ],
                  ),
              ],
            ),
    );
  }
}

class _InventoryCard extends StatelessWidget {
  const _InventoryCard({required this.title, required this.entries});
  final String title;
  final List<InventoryEntry>? entries;

  @override
  Widget build(BuildContext context) {
    final list = entries;
    final muted = ProText.meta;
    return ProCard(
      title: title,
      aside: list == null ? null : Text('${list.length}'),
      child: list == null
          ? Text('不报告。', style: muted)
          : list.isEmpty
          ? Text('没有。', style: muted)
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final e in list)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          e.name,
                          style: ProText.mono.copyWith(
                            color: e.enabled == false ? ProColor.muted : ProColor.ink,
                            decoration: e.enabled == false ? TextDecoration.lineThrough : null,
                          ),
                        ),
                        if (e.description case final d? when d.isNotEmpty) Text(d, style: muted, maxLines: 1, overflow: TextOverflow.ellipsis),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}

class _AgentsCard extends StatelessWidget {
  const _AgentsCard({required this.runtime, required this.agents});
  final String runtime;
  final List<Agent> agents;

  @override
  Widget build(BuildContext context) => ProCard(
    title: '用到它的 agent',
    aside: TextLink('用它捏一个新 agent →', onTap: () => workbenchGo(context, '/agents/new?runtime=${Uri.encodeComponent(runtime)}')),
    child: agents.isEmpty
        ? Text('还没有。', style: ProText.meta)
        : Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final a in agents)
                Tappable(
                  onTap: () => workbenchGo(context, '/agents/${Uri.encodeComponent(a.id)}'),
                  builder: (context, s) => Container(
                    padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
                    decoration: BoxDecoration(color: s.hovered ? ProColor.hover : null, border: const Border.fromBorderSide(proLine), borderRadius: proRadius),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        AgentFace(look: a.look, id: a.id, size: 26),
                        const SizedBox(width: 6),
                        Text(a.name, style: ProText.sm),
                      ],
                    ),
                  ),
                ),
            ],
          ),
  );
}

String _capabilityLabel(RuntimeCapability c) => switch (c) {
  RuntimeCapability.listModels => '模型列表',
  RuntimeCapability.accountUsage => '账户用量',
  RuntimeCapability.checkUpdate => '检查更新',
  RuntimeCapability.upgrade => '升级',
  RuntimeCapability.skills => '技能清单',
  RuntimeCapability.mcpServers => 'MCP 清单',
  RuntimeCapability.tools => '工具清单',
};
