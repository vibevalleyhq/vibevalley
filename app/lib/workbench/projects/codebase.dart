import 'dart:ui' show Color;

import '../../gen/vibevalley.dart';

class LangDef {
  const LangDef(this.label, this.color, this.names);
  final String label;

  final Color color;

  final List<String> names;
}

const langs = <String, LangDef>{
  'typescript': LangDef('TypeScript', Color(0xFF3178C6), ['typescript', 'tsx', 'ts']),
  'javascript': LangDef('JavaScript', Color(0xFFF1E05A), ['javascript', 'jsx', 'js', 'mjs', 'cjs']),
  'python': LangDef('Python', Color(0xFF3572A5), ['python', 'py', 'cython']),
  'go': LangDef('Go', Color(0xFF00ADD8), ['go', 'golang']),
  'rust': LangDef('Rust', Color(0xFFDEA584), ['rust', 'rs']),
  'java': LangDef('Java', Color(0xFFB07219), ['java']),
  'kotlin': LangDef('Kotlin', Color(0xFFA97BFF), ['kotlin', 'kt']),
  'swift': LangDef('Swift', Color(0xFFF05138), ['swift']),
  'c': LangDef('C', Color(0xFF555555), ['c', 'c header']),
  'cpp': LangDef('C++', Color(0xFFF34B7D), ['c++', 'cpp', 'c++ header']),
  'csharp': LangDef('C#', Color(0xFF178600), ['c#', 'csharp', 'cs']),
  'ruby': LangDef('Ruby', Color(0xFF701516), ['ruby', 'rb']),
  'php': LangDef('PHP', Color(0xFF4F5D95), ['php', 'hack']),
  'shell': LangDef('Shell', Color(0xFF89E051), ['shell', 'bash', 'zsh', 'sh', 'fish']),
  'html': LangDef('HTML', Color(0xFFE34C26), ['html']),
  'css': LangDef('CSS', Color(0xFF563D7C), ['css', 'less']),
  'sql': LangDef('SQL', Color(0xFFE38C00), ['sql', 'plpgsql', 'tsql', 'plsql']),
  'dart': LangDef('Dart', Color(0xFF00B4AB), ['dart']),
  'lua': LangDef('Lua', Color(0xFF000080), ['lua', 'luau']),
  'scala': LangDef('Scala', Color(0xFFC22D40), ['scala']),
  'elixir': LangDef('Elixir', Color(0xFF6E4A7E), ['elixir', 'ex']),
  'haskell': LangDef('Haskell', Color(0xFF5E5086), ['haskell', 'hs']),
  'zig': LangDef('Zig', Color(0xFFEC915C), ['zig']),
  'r': LangDef('R', Color(0xFF198CE7), ['r', 'rmarkdown']),
  'markdown': LangDef('Markdown', Color(0xFF083FA1), ['markdown', 'md', 'mdx']),
  'json': LangDef('JSON', Color(0xFF292929), ['json', 'json with comments', 'json5', 'jsonc']),
  'yaml': LangDef('YAML', Color(0xFFCB171E), ['yaml', 'yml']),
  'julia': LangDef('Julia', Color(0xFFA270BA), ['julia', 'jl']),
  'vue': LangDef('Vue', Color(0xFF41B883), ['vue']),
  'svelte': LangDef('Svelte', Color(0xFFFF3E00), ['svelte']),
  'docker': LangDef('Dockerfile', Color(0xFF384D54), ['dockerfile', 'docker']),
  'jupyter': LangDef('Jupyter', Color(0xFFDA5B0B), ['jupyter notebooks', 'jupyter notebook', 'jupyter', 'ipynb']),
  'sass': LangDef('Sass', Color(0xFFC6538C), ['scss', 'sass']),
  'powershell': LangDef('PowerShell', Color(0xFF012456), ['powershell', 'ps1']),
  'terraform': LangDef('Terraform', Color(0xFF844FBA), ['hcl', 'terraform', 'tf']),
  'other': LangDef('其他', Color(0xFFA08C70), []),
};

final _byName = <String, String>{
  for (final MapEntry(:key, :value) in langs.entries)
    for (final n in value.names) n: key,
};

class Language {
  const Language(this.id, this.label, this.color);
  final String id;
  final String label;
  final Color color;
}

Language languageOf(String name) {
  final id = _byName[name.trim().toLowerCase()] ?? 'other';
  final def = langs[id]!;
  return Language(id, id == 'other' && name.trim().isNotEmpty ? name.trim() : def.label, def.color);
}

String langIcon(String id) => 'lang-$id';

class LanguageShare extends Language {
  const LanguageShare(super.id, super.label, super.color, {required this.lines, required this.files, required this.share});

  /// Prose in Markdown counts as comments.
  final double lines;
  final double files;

  /// 0..1.
  final double share;
}

List<LanguageShare> languageShares(List<LanguageCount> counts, {int? top = 7}) {
  final merged = <String, ({Language language, double lines, double files})>{};
  for (final c in counts) {
    final language = languageOf(c.name);
    final e = merged[language.label];
    merged[language.label] = (language: language, lines: (e?.lines ?? 0) + c.code + c.comments, files: (e?.files ?? 0) + c.files);
  }
  final all = merged.values.where((e) => e.lines > 0).toList()
    ..sort((a, b) {
      final byLines = b.lines.compareTo(a.lines);
      return byLines != 0 ? byLines : a.language.label.compareTo(b.language.label);
    });
  final total = all.fold<double>(0, (n, e) => n + e.lines);
  final cut = top ?? all.length;
  final rest = all.length > cut ? all.sublist(cut) : const <({Language language, double lines, double files})>[];
  final kept = rest.length > 1 ? all.sublist(0, cut) : all;
  final shares = [
    for (final e in kept)
      LanguageShare(e.language.id, e.language.label, e.language.color, lines: e.lines, files: e.files, share: total > 0 ? e.lines / total : 0),
  ];
  if (rest.length <= 1) return shares;
  final lines = rest.fold<double>(0, (n, e) => n + e.lines);
  final other = langs['other']!;
  return [
    ...shares,
    LanguageShare('other', other.label, other.color, lines: lines, files: rest.fold<double>(0, (n, e) => n + e.files), share: total > 0 ? lines / total : 0),
  ];
}

String _two(int n) => n.toString().padLeft(2, '0');

/// The server counts commits by the same day.
String dayKey(DateTime d) => '${d.year}-${_two(d.month)}-${_two(d.day)}';

class CalendarDay {
  const CalendarDay({required this.day, required this.at, required this.commits, required this.level, required this.future});
  final String day;

  final DateTime at;
  final int commits;

  /// 0 bare, 1 seeded, 2 sprouting, 3 leafy, 4 in flower.
  final int level;

  final bool future;
}

class Calendar {
  const Calendar(this.weeks, this.months);

  final List<List<CalendarDay>> weeks;

  final List<({int week, String label})> months;
}

/// By the calendar: a day is not always 24 hours.
DateTime _plusDays(DateTime from, int offset) => DateTime(from.year, from.month, from.day + offset);

/// Levels go against the year's 95th percentile, so one huge day does not leave the rest bare.
Calendar calendarOf(List<DayCount> days, DateTime now, {int weeks = 53}) {
  final commits = {for (final d in days) d.day: d.commits.round()};
  final today = _plusDays(now, 0);
  final monday = _plusDays(today, -(today.weekday - 1));
  final start = _plusDays(monday, -(weeks - 1) * 7);
  final busyDays = commits.values.where((n) => n > 0).toList()..sort();
  final q = busyDays.isEmpty ? 0 : busyDays[(0.95 * busyDays.length).floor().clamp(0, busyDays.length - 1)];
  final busy = q < 1 ? 1 : q;
  int level(int n) => n <= 0 ? 0 : ((4 * n) / busy).ceil().clamp(0, 4);
  final grid = <List<CalendarDay>>[];
  final months = <({int week, String label})>[];
  for (var w = 0; w < weeks; w++) {
    final column = <CalendarDay>[];
    for (var d = 0; d < 7; d++) {
      final at = _plusDays(start, w * 7 + d);
      final day = dayKey(at);
      final n = commits[day] ?? 0;
      column.add(CalendarDay(day: day, at: at, commits: n, level: level(n), future: at.isAfter(today)));
      // A month's name over the week its first day is in; the first week names the month it shows.
      if ((at.day == 1 || (w == 0 && d == 0)) && (months.isEmpty || months.last.week != w)) months.add((week: w, label: '${at.month}月'));
    }
    grid.add(column);
  }
  // A first label crowded by the next month's is dropped.
  if (months.length > 1 && months[1].week - months[0].week < 3) months.removeAt(0);
  return Calendar(grid, months);
}

class Streaks {
  const Streaks({required this.total, required this.days, required this.longest, required this.current, this.busiest});

  final int total;
  final int days;

  /// The current run goes to today, or to yesterday if none yet today.
  final int longest;
  final int current;

  /// The latest, on a tie.
  final ({String day, int commits})? busiest;
}

Streaks streaksOf(Calendar calendar) {
  final days = [
    for (final w in calendar.weeks)
      for (final d in w)
        if (!d.future) d,
  ];
  var longest = 0;
  var run = 0;
  ({String day, int commits})? busiest;
  for (final d in days) {
    run = d.commits > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
    if (d.commits > 0 && d.commits >= (busiest?.commits ?? 0)) busiest = (day: d.day, commits: d.commits);
  }
  var current = 0;
  final last = days.isEmpty ? null : days.last;
  for (var i = days.length - 1 - (last != null && last.commits == 0 ? 1 : 0); i >= 0 && days[i].commits > 0; i--) {
    current++;
  }
  return Streaks(
    total: days.fold(0, (n, d) => n + d.commits),
    days: days.where((d) => d.commits > 0).length,
    longest: longest,
    current: current,
    busiest: busiest,
  );
}

typedef Growth = ({String crop, String label});

Growth growthOf(double? last, double now) {
  if (last == null) return (crop: 'empty', label: '还没动过土');
  final days = (now - last) / dayMs;
  if (days <= 1) return (crop: 'flowering', label: '正旺');
  if (days <= 7) return (crop: 'leafy', label: '在长');
  if (days <= 30) return (crop: 'sprout', label: '冒着芽');
  if (days <= 90) return (crop: 'dry', label: '有点干了');
  return (crop: 'withered', label: '荒了');
}

/// Only repository home URLs, never credentials, arbitrary git transports or command-line options.
({String name, String url})? githubRepository(String input) {
  final match = RegExp(r'^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?$').firstMatch(input.trim());
  if (match == null) return null;
  final name = match[2]!.replaceFirst(RegExp(r'\.git$'), '');
  if (name.isEmpty || name == '.' || name == '..') return null;
  return (name: name, url: 'https://github.com/${match[1]}/$name.git');
}

List<ProjectSummary> sortProjects(List<ProjectSummary> list) => [...list]
  ..sort((a, b) {
    final byLast = (b.last ?? 0).compareTo(a.last ?? 0);
    return byLast != 0 ? byLast : a.name.compareTo(b.name);
  });
