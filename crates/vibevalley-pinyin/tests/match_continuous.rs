use std::collections::HashSet;
use std::time::Instant;

use vibevalley_pinyin::{CJK_END, CJK_START, has_pinyin, match_continuous, readings};

#[test]
fn cjk_table_invariants_and_coverage() {
    let mut mapped = 0usize;
    let mut polyphones = 0usize;

    for cp in CJK_START..=CJK_END {
        let ch = char::from_u32(cp).expect("CJK range is valid Unicode scalar values");
        let r = readings(ch);
        if r.is_empty() {
            continue;
        }
        mapped += 1;
        if r.len() > 1 {
            polyphones += 1;
        }

        let mut seen = HashSet::new();
        for py in r {
            assert!((1..=6).contains(&py.len()), "unexpected syllable length for {ch} (U+{cp:04X}): {py:?}");
            assert!(py.bytes().all(|b| b.is_ascii_lowercase()), "syllable must be lowercase ASCII for {ch}: {py:?}");
            assert!(seen.insert(py), "duplicate reading {py:?} for {ch} (U+{cp:04X})");
        }
        assert_eq!(r.iter().len(), r.len());
        assert_eq!(r.first(), r.get(0));
        assert_eq!(r.get(r.len()), None);
    }

    assert!(mapped >= 20_800, "expected full BMP CJK coverage, got {mapped}");
    assert!(polyphones >= 2_400, "expected comprehensive polyphone coverage, got {polyphones}");

    // Supplementary CJK zero and non-CJK exclusions.
    assert_eq!(readings('〇').first(), Some("ling"));
    assert!(has_pinyin('中'));
    assert!(!has_pinyin('a'));
    assert!(!has_pinyin('0'));
    assert!(!has_pinyin(' '));
    assert!(!has_pinyin('🌾'));
}

#[test]
fn polyphone_readings_cover_common_characters() {
    let cases: &[(char, &[&str])] = &[
        ('重', &["zhong", "chong"]),
        ('行', &["xing", "hang", "heng"]),
        ('长', &["chang", "zhang"]),
        ('乐', &["le", "yue"]),
        ('得', &["de", "dei"]),
        ('绿', &["lv", "lu"]),
        ('女', &["nv", "ru"]),
        ('略', &["lve"]),
        ('调', &["diao", "tiao"]),
        ('朝', &["chao", "zhao"]),
        ('单', &["dan", "shan", "chan"]),
        ('阿', &["a", "e"]),
        ('系', &["xi", "ji"]),
        ('数', &["shu", "shuo"]),
        ('传', &["chuan", "zhuan"]),
    ];

    for &(ch, expected) in cases {
        let r = readings(ch);
        for &syl in expected {
            assert!(r.contains(syl), "expected {ch} to include reading {syl:?}, got {r:?}");
        }
    }
}

#[test]
fn direct_substring_case_insensitive_fast_path() {
    assert!(match_continuous("VibeValley", "vibe"));
    assert!(match_continuous("VibeValley", "VALLEY"));
    assert!(match_continuous("VibeValley", "beva"));
    assert!(!match_continuous("VibeValley", "vv"));
    assert!(match_continuous("工单系统", "工单"));
    assert!(match_continuous("工单系统", "单系"));
    assert!(match_continuous("AI 帮工", "ai"));
    assert!(match_continuous("AI 帮工", "AI 帮"));
    assert!(match_continuous("ÜBER", "über"));
    assert!(match_continuous("über", "ÜBER"));
}

#[test]
fn continuous_pinyin_initials_and_full_or_partial_prefix() {
    let should_match: &[(&str, &str)] = &[
        ("中文", "zw"),
        ("中文", "zhongw"),
        ("中文", "zhongwen"),
        ("中文", "zh"),
        ("中文", "zho"),
        ("中文", "wen"),
        ("中文", "w"),
        ("中文", "ZW"),
        ("中文", "ZhongWen"),
        ("工单", "gd"),
        ("工单", "gongdan"),
        ("工单", "gongd"),
        ("工单", "gongda"),
        ("工单", "gdan"),
        ("工单", "gda"),
        ("中国", "zg"),
        ("中国", "zhongg"),
        ("中国", "zguo"),
        ("中国", "zhongguo"),
        ("工单系统", "gd"),
        ("工单系统", "gdx"),
        ("工单系统", "gdxt"),
        ("工单系统", "xt"),
        ("工单系统", "xit"),
        ("工单系统", "danx"),
        ("工单系统", "danxitong"),
        ("二零二六", "erling"),
        ("二〇二六", "erling"),
    ];

    for &(text, query) in should_match {
        assert!(match_continuous(text, query), "expected `{query}` to match `{text}`");
    }

    let should_not_match: &[(&str, &str)] = &[
        ("中文", "zhw"),
        ("中文", "zwx"),
        ("中文", "wz"),
        ("中文", "zhongweng"),
        ("工单系统", "gdt"),
        ("工单系统", "gxt"),
        ("工单系统", "gongx"),
        ("工单", "gon单"),
        ("工单", "工单工"),
    ];

    for &(text, query) in should_not_match {
        assert!(!match_continuous(text, query), "expected `{query}` NOT to match `{text}`");
    }
}

#[test]
fn polyphone_continuous_matching() {
    let cases: &[(&str, &str, bool)] = &[
        ("重新开始", "cxks", true),
        ("重新开始", "chongxin", true),
        ("重新开始", "chongx", true),
        ("重新开始", "zxks", true),
        ("重要事项", "zy", true),
        ("重要事项", "zhongyao", true),
        ("银行账户", "yh", true),
        ("银行账户", "yinhang", true),
        ("银行账户", "yinhangzh", true),
        ("行为规范", "xw", true),
        ("行为规范", "xingwei", true),
        ("成长记录", "cz", true),
        ("成长记录", "chengzhang", true),
        ("长度限制", "cd", true),
        ("长度限制", "changdu", true),
        ("音乐播放", "yy", true),
        ("音乐播放", "yinyue", true),
        ("快乐农场", "kl", true),
        ("快乐农场", "kuaile", true),
        ("阿胶糕", "ejiao", true),
        ("阿胶糕", "ajiao", true),
        ("得到结果", "dedao", true),
        ("得到结果", "deidao", true),
        ("单于庭", "shanyut", true),
        ("工单", "gongdan", true),
        ("重新开始", "chongk", false),
    ];

    for &(text, query, expected) in cases {
        assert_eq!(match_continuous(text, query), expected, "text={text:?} query={query:?}");
    }
}

#[test]
fn mixed_ascii_cjk_punctuation_and_spaces() {
    let cases: &[(&str, &str, bool)] = &[
        ("工单", "工d", true),
        ("工单", "工dan", true),
        ("工单", "g单", true),
        ("工单", "gong单", true),
        ("AI帮工", "ai帮g", true),
        ("AI帮工", "ai帮gong", true),
        ("AI帮工", "aibg", true),
        ("AI帮工", "aibangg", true),
        ("AI帮工", "aibanggong", true),
        ("AI帮工", "AI帮G", true),
        ("AI帮工", "ai帮x", false),
        ("中文 测试", "zwcs", true),
        ("中文 测试", "zw cs", true),
        ("中文 测试", "zhongwen ceshi", true),
        ("中文 测试", "zhongwenc", true),
        ("中文-测试", "zwcs", false),
        ("中文-测试", "zw-cs", true),
        ("工单 #12", "gd", true),
        ("工单 #12", "gongd", true),
        ("工单 #12", "gd#12", true),
        ("工单 #12", "gd12", false),
        ("工单#12", "gd#12", true),
        ("工单#12", "gd12", false),
        ("foo bar", "foobar", true),
        ("🌾 农场任务 #42", "ncrw", true),
        ("🌾 农场任务 #42", "🌾ncrw", true),
        ("🌾 农场任务 #42", "ncrw#42", true),
        ("🌾 农场任务 #42", "ncrw42", false),
    ];

    for &(text, query, expected) in cases {
        assert_eq!(match_continuous(text, query), expected, "text={text:?} query={query:?}");
    }
}

#[test]
fn umlaut_v_and_tone_stripped_ascii_queries() {
    let cases: &[(&str, &str, bool)] = &[
        ("绿色农场", "lvse", true),
        ("绿色农场", "lüse", true),
        ("绿色农场", "luse", true),
        ("绿色农场", "lsnc", true),
        ("旅游日志", "lvyou", true),
        ("旅游日志", "lüyou", true),
        ("旅游日志", "luyou", false),
        ("女士用品", "nvshi", true),
        ("女士用品", "nüshi", true),
        ("女士用品", "nushi", false),
        ("战略规划", "zhanlve", true),
        ("战略规划", "zhanlüe", true),
        ("战略规划", "zhanlue", false),
        ("中文测试", "zhōngwén", true),
        ("绿色", "lǜsè", true),
    ];

    for &(text, query, expected) in cases {
        assert_eq!(match_continuous(text, query), expected, "text={text:?} query={query:?}");
    }
}

#[test]
fn empty_whitespace_and_long_queries() {
    assert!(match_continuous("中文", ""));
    assert!(match_continuous("", ""));
    assert!(!match_continuous("", "a"));
    assert!(!match_continuous("", "zw"));
    assert!(!match_continuous("中文", "   "));
    assert!(match_continuous("  ", "  "));
    assert!(match_continuous("中文", "z "));
    assert!(match_continuous("中文", " z "));

    // Queries longer than STACK_QUERY_LIMIT (64 chars) exercise heap fallback cleanly.
    let long_text = "工单".repeat(40);
    let long_full = "gongdan".repeat(12); // 84 bytes
    let long_initials = "gd".repeat(35); // 70 bytes
    let long_miss = format!("{}x", "gd".repeat(35));
    assert!(match_continuous(&long_text, &long_full));
    assert!(match_continuous(&long_text, &long_initials));
    assert!(!match_continuous(&long_text, &long_miss));
}

#[test]
fn performance_ten_thousand_titles() {
    let corpus = [
        "修复工单列表在快速切换频道时的渲染闪烁问题 #142",
        "AI帮工自动合入主分支前的冲突检测与重试机制",
        "VibeValley 原生桌面端像素农场音效合成器优化",
        "重新梳理知识库双向链接与块引用渲染管线",
        "支持长文本流式 Markdown 增量解析与数学公式",
        "银行级密钥隔离存储与本地工作区权限边界审计",
        "Search query filtering for artifacts and media library",
        "绿色环保低能耗后台巡查调度策略设计笔记",
    ];
    let queries = ["gd", "aibg", "chongxin", "zhanlve", "zhongwen", "yx", "vibe", "ncrw"];

    let start = Instant::now();
    let mut hits = 0usize;
    for i in 0..10_000 {
        let text = corpus[i % corpus.len()];
        let query = queries[i % queries.len()];
        if match_continuous(text, query) {
            hits += 1;
        }
    }
    let elapsed = start.elapsed();

    assert!(hits > 0);
    assert!(
        elapsed.as_millis() < 2_000,
        "10,000 continuous pinyin matches took {elapsed:?} (expected well under 2s even in debug)"
    );
}
