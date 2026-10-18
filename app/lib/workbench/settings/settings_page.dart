import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../shared/settings_form.dart';
import '../../ui/kit/kit.dart';
import '../shared/layout.dart';
import '../shared/widgets.dart';

/// The parts of 设置, each its own address so a link lands on it. The first four are the server's settings; the rest are
/// whole pages of their own (a list and its detail), shown beside this menu.
enum SettingsSection {
  deepseek('DeepSeek', '管家用的钥匙'),
  agora('Agora 语音', 'App ID 和 Certificate'),
  memory('记性', 'Nowledge Mem、EverOS'),
  github('GitHub', 'gh 和登录，能不能提 PR'),
  connectors('连接器', '微信 飞书 QQ'),
  skills('技能', '帮工能带的技能'),
  voice('声音', '和管家打电话'),
  gate('院门', '手机和别的电脑');

  const SettingsSection(this.label, this.line);
  final String label;
  final String line;

  String get path => '/settings/$name';

  /// /settings/<section>/… names it; /settings alone is the first.
  static SettingsSection of(String location) {
    final parts = Uri.parse(location).pathSegments;
    final name = parts.length > 1 ? parts[1] : null;
    return values.where((s) => s.name == name).firstOrNull ?? deepseek;
  }
}

/// 设置's menu on the left, whatever section is open on the right; switching never moves the menu.
class SettingsShell extends StatelessWidget {
  const SettingsShell({super.key, required this.section, required this.child});
  final SettingsSection section;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final menu = ListCard(
      title: '设置',
      semanticLabel: '设置的分区',
      children: [
        for (final s in SettingsSection.values) ListRow(active: s == section, onTap: () => workbenchGo(context, s.path), child: RowText(s.label, s.line)),
      ],
    );
    return LayoutBuilder(
      builder: (context, box) {
        final gap = box.maxWidth >= 640 ? 12.0 : 8.0;
        if (box.maxWidth < wideFrom) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: EdgeInsets.fromLTRB(gap, 0, gap, gap),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final s in SettingsSection.values)
                      PxButton.text(
                        s.label,
                        size: PxSize.sm,
                        tone: s == section ? PxTone.primary : PxTone.plain,
                        onPressed: () => workbenchGo(context, s.path),
                      ),
                  ],
                ),
              ),
              Expanded(child: child),
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(gap, 0, 0, 12),
              child: SizedBox(width: 220, child: PxScrollView(child: menu)),
            ),
            Expanded(child: child),
          ],
        );
      },
    );
  }
}

/// One of the server's settings, as a card beside the menu.
class SettingsPartPage extends StatelessWidget {
  const SettingsPartPage({super.key, required this.section});
  final SettingsSection section;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final gap = box.maxWidth >= 640 ? 12.0 : 8.0;
      return PxScrollView(
        padding: EdgeInsets.fromLTRB(gap, 0, gap, 12),
        child: Align(
          alignment: Alignment.topLeft,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: PxCard(
              title: section.label,
              child: switch (section) {
                SettingsSection.deepseek => const SettingsForm(key: ValueKey('deepseek'), part: SettingsPart.deepseek),
                SettingsSection.agora => const SettingsForm(key: ValueKey('agora'), part: SettingsPart.agora),
                SettingsSection.memory => const SettingsForm(key: ValueKey('memory'), part: SettingsPart.memory),
                _ => const _GitHub(),
              },
            ),
          ),
        ),
      );
    },
  );
}

/// What the server found of gh (github.status); only read here, a refresh asks it to look again.
class _GitHub extends ConsumerStatefulWidget {
  const _GitHub();

  @override
  ConsumerState<_GitHub> createState() => _GitHubState();
}

class _GitHubState extends ConsumerState<_GitHub> {
  late Future<GitHubStatus> _status = ref.read(apiProvider).github.status();

  @override
  Widget build(BuildContext context) => FutureBuilder<GitHubStatus>(
    future: _status,
    builder: (context, snap) {
      final s = snap.data;
      final lines = s == null
          ? [snap.hasError ? '问不到服务端：${snap.error}' : '在问服务端……']
          : [s.installed ? 'gh ${s.version}' : '没装 gh', if (s.loggedIn) '已登录 github.com：${s.account}', if (s.reason.isNotEmpty) s.reason];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(line, style: KitText.sm.copyWith(color: Palette.bark800)),
            ),
          const SizedBox(height: 6),
          Text('能提 PR 的项目在「项目」里看；收获时提 PR 要在配置里打开（github.pr_projects）。', style: KitText.xs.copyWith(color: Palette.bark500)),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: PxButton.text('重新检测', onPressed: () => setState(() => _status = ref.read(apiProvider).github.refresh())),
          ),
        ],
      );
    },
  );
}
