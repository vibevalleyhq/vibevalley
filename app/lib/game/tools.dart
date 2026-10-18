// aimTool is the rule: the screen shows it while pointing and follows it on a click.

import 'package:flutter/services.dart' show LogicalKeyboardKey;

import '../gen/vibevalley.dart';
import '../rules/beds.dart';
import '../rules/sessions.dart';

export '../rules/beds.dart' show Bed, beds, bedOfStation, isRipe;

enum Tool {
  hand('手', '点一块地看详情，点空地播种', 'icon-hand'),
  water('浇水', '给帮工带句话，正在干活的会中途收到', 'icon-water'),
  bug('杀虫', '活没做成（地里有虫）：让它接着修', 'icon-bug'),
  weed('除草', '没过验收的意见会长成杂草：帮工修完、下一次验收通过就拔掉', 'icon-weed'),
  harvest('收获', '熟了的地：收下成果，帮工收工', 'icon-harvest'),
  shovel('铲除', '正在干活的叫停；没在干活的请它收工', 'icon-shovel');

  const Tool(this.label, this.hint, this.icon);
  final String label;
  final String hint;
  final String icon;
}

class Aim {
  const Aim(this.ok, this.text);
  final bool ok;
  final String text;
}

/// A click's decision, taken once: the page plays its sound and the command acts on the same snapshot.
class PlotAim {
  const PlotAim({required this.bed, required this.tool, required this.session, required this.aim});
  final Bed bed;
  final Tool tool;
  final Session? session;
  final Aim aim;
}

sealed class ToolResult {
  const ToolResult();
}

final class ToolDone extends ToolResult {
  const ToolDone();
}

final class ToolRefused extends ToolResult {
  const ToolRefused(this.text);
  final String text;
}

final class ToolSow extends ToolResult {
  const ToolSow(this.station);
  final int station;
}

final class ToolInspect extends ToolResult {
  const ToolInspect(this.sessionId);
  final String sessionId;
}

final class ToolWater extends ToolResult {
  const ToolWater(this.sessionId);
  final String sessionId;
}

final class ToolReview extends ToolResult {
  const ToolReview(this.sessionId);
  final String sessionId;
}

enum BedFxKind { water, spray, harvest, shovel, note }

/// 0..5, or -1 while every bed is taken.
int stationOfSession(Session h) => h.play?.station.round() ?? -1;

Session? stationOf(List<Session> sessions, int station) => station < 0 ? null : sessions.where((h) => stationOfSession(h) == station).firstOrNull;

int? nextClearing(int level) => beds.where((b) => b.unlockLevel != null && b.unlockLevel! > level).firstOrNull?.unlockLevel;

PlotView plotOf(FarmView view, Session? h) => h == null ? const PlotView(crop: Crop.empty) : (view.plots[plotKey(h)] ?? const PlotView(crop: Crop.empty));

PlotView lockedPlot(Bed bed, int level) => PlotView(crop: level >= (bed.unlockLevel ?? 1 << 30) ? Crop.flowering : Crop.locked);

const cropLabel = {
  Crop.empty: '空地',
  Crop.seeded: '刚播种',
  Crop.sprout: '发芽',
  Crop.leafy: '长叶',
  Crop.flowering: '开花',
  Crop.wheat: '成熟',
  Crop.carrot: '成熟',
  Crop.withered: '枯萎',
  Crop.weeds: '长草',
  Crop.dry: '干旱',
  Crop.harvested: '收完了',
  Crop.locked: '没开垦',
};

Aim aimTool(Tool tool, Bed bed, Session? session, PlotView plot, int level) {
  final unlock = bed.unlockLevel;
  if (unlock != null) return Aim(false, level >= unlock ? '开垦好的花坛' : 'Lv.$unlock 开垦这块地');
  final crop = plot.crop;
  switch (tool) {
    case Tool.hand:
      return Aim(true, session != null ? '看看这块地' : '播种');
    case Tool.water:
      return session != null ? Aim(true, '给${session.name}浇水（带句话）') : const Aim(false, '还没种东西，先用手播种');
    case Tool.bug:
      return session != null && crop == Crop.withered ? const Aim(true, '杀虫：让它接着修') : const Aim(false, '这块地没有虫');
    case Tool.weed:
      return Aim(false, crop == Crop.weeds ? '帮工修完、验收通过草就拔了' : '没有杂草');
    case Tool.harvest:
      // A task's step goes into the task's branch by itself; the whole task is harvested on its board.
      if (session?.graph != null) return const Aim(false, '计划里的一步：做完自动合进计划分支');
      return session != null && canHarvest(session)
          ? Aim(true, isRipe(crop) ? '收获，帮工收工' : '收获：看看它改了什么')
          : Aim(false, session != null ? '还没熟，等它做完' : '空地没有东西可收');
    case Tool.shovel:
      return session != null ? Aim(true, session.phase is PhaseWorking ? '铲除：叫停' : '铲除：请它收工') : const Aim(false, '空地不用铲');
  }
}

String bugText(String task) {
  final original = task.replaceFirst(RegExp(r'^接着修：'), '').replaceFirst(RegExp(r'。看一下报错，修好再跑一遍测试$'), '');
  return '接着修：$original。看一下报错，修好再跑一遍测试';
}

/// The young farmer stands in for a look not painted.
String managerSprite(String look, String suffix, bool Function(String) has) => has('manager-$look$suffix') ? 'manager-$look$suffix' : 'manager$suffix';

bool lookReady(String look, bool Function(String) has) => look == 'farmer' || has('manager-$look');

const petName = {'dog': '小狗', 'ragdoll': '重点色布偶猫', 'bluecat': '蓝猫'};

Tool? toolForKey(LogicalKeyboardKey key) {
  final n = LogicalKeyboardKey.digit1.keyId;
  final i = key.keyId - n;
  return i >= 0 && i < Tool.values.length ? Tool.values[i] : null;
}
