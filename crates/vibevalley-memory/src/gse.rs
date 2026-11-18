//! Chinese word segmentation as gse cuts it (dictionary DAG + jieba's HMM
//! for unknown runs). A line-by-line port of VibeValley
//! `apps/server/src/modules/memory/gse.ts`; the golden test
//! checks it against that file's own output.

use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

use regex::Regex;

/// Go's `strings.ToLower` where it differs: İ is a plain i.
pub fn go_lower(s: &str) -> String {
    s.replace('İ', "i").to_lowercase()
}

fn lowerable(c: char) -> bool {
    c.is_ascii_alphabetic() || ('\u{aa}'..='\u{7ff}').contains(&c)
}

/// How gse keys a dictionary word: letters and digits below U+0800 lowered.
fn key_of(text: &str) -> String {
    if !text.chars().any(lowerable) {
        return text.to_string();
    }
    text.chars()
        .map(|c| {
            if (c as u32) < 0x800 && c.is_alphanumeric() {
                go_lower(&c.to_string())
            } else {
                c.to_string()
            }
        })
        .collect()
}

struct Dictionary {
    freq: HashMap<String, f64>,
    /// Sorted keys: a prefix is known when the first key at or after it
    /// starts with it.
    sorted: Vec<String>,
    total: f64,
}

fn gunzip(bytes: &[u8]) -> String {
    let mut out = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut out).expect("bundled data is gzip text");
    out
}

/// strconv.ParseFloat's grammar: a number written whole, or nothing.
fn go_parse_float(text: &str) -> Option<f64> {
    static NUM: OnceLock<Regex> = OnceLock::new();
    let re = NUM.get_or_init(|| Regex::new(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$").expect("regex"));
    re.is_match(text).then(|| text.parse().ok()).flatten()
}

fn dict() -> &'static Dictionary {
    static DICT: OnceLock<Dictionary> = OnceLock::new();
    DICT.get_or_init(|| {
        let text = gunzip(include_bytes!("../data/zh_s.txt.gz"));
        let mut freq = HashMap::new();
        let mut total = 0.0;
        for line in text.split('\n') {
            let Some(first) = line.find(' ') else { continue };
            let word = line[..first].trim();
            let rest = &line[first + 1..];
            let freq_text = rest.split(' ').next().unwrap_or("").trim();
            let Some(mut f) = go_parse_float(freq_text) else { continue };
            if f < 2.0 {
                continue;
            }
            if word.chars().count() < 2 {
                f = 2.0;
            }
            let key = key_of(word);
            if freq.contains_key(&key) {
                continue;
            }
            freq.insert(key, f);
            total += f;
        }
        let mut sorted: Vec<String> = freq.keys().cloned().collect();
        sorted.sort_unstable();
        Dictionary { freq, sorted, total }
    })
}

/// The word's frequency; `Some(0)` when it only begins a word.
fn find(word: &str) -> Option<f64> {
    let d = dict();
    if let Some(f) = d.freq.get(word) {
        return Some(*f);
    }
    let at = d.sorted.partition_point(|k| k.as_str() < word);
    d.sorted.get(at).filter(|k| k.starts_with(word)).map(|_| 0.0)
}

/// For each start, the ends of the dictionary words starting there; itself
/// when none does.
fn dag_of(runes: &[char]) -> Vec<Vec<usize>> {
    let n = runes.len();
    let mut dag = Vec::with_capacity(n);
    for k in 0..n {
        let mut ends = vec![];
        let mut i = k;
        let mut frag = runes[k].to_string();
        while let Some(f) = find(&frag) {
            if f > 0.0 {
                ends.push(i);
            }
            i += 1;
            if i >= n {
                break;
            }
            frag.push(runes[i]);
        }
        dag.push(if ends.is_empty() { vec![k] } else { ends });
    }
    dag
}

/// The most likely path: each start's best end, from the back.
fn routes_of(runes: &[char]) -> Vec<(f64, usize)> {
    let dag = dag_of(runes);
    let n = runes.len();
    let mut routes = vec![(0.0_f64, 0usize); n + 1];
    let log_t = dict().total.ln();
    for idx in (0..n).rev() {
        let score = |end: usize, routes: &[(f64, usize)]| {
            let word: String = runes[idx..=end].iter().collect();
            let f = find(&word).map(f64::ln).unwrap_or(0.0);
            // ln(0) is -inf, as Math.log(0) in the original.
            (f - log_t + routes[end + 1].0, end)
        };
        let ends = &dag[idx];
        let mut best = score(ends[0], &routes);
        for &end in &ends[1..] {
            let r = score(end, &routes);
            if r.0 > best.0 || (r.0 == best.0 && r.1 > best.1) {
                best = r;
            }
        }
        routes[idx] = best;
    }
    routes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum State {
    B,
    E,
    M,
    S,
}

const STATES: [State; 4] = [State::B, State::M, State::E, State::S];
const MIN_FLOAT: f64 = -3.14e100;

fn emit() -> &'static HashMap<State, HashMap<String, f64>> {
    static EMIT: OnceLock<HashMap<State, HashMap<String, f64>>> = OnceLock::new();
    EMIT.get_or_init(|| {
        let text = gunzip(include_bytes!("../data/hmm_emit.json.gz"));
        let raw: HashMap<String, HashMap<String, f64>> = serde_json::from_str(&text).expect("bundled HMM table");
        raw.into_iter()
            .filter_map(|(k, v)| {
                let s = match k.as_str() {
                    "B" => State::B,
                    "E" => State::E,
                    "M" => State::M,
                    "S" => State::S,
                    _ => return None,
                };
                Some((s, v))
            })
            .collect()
    })
}

fn prev_status(s: State) -> [State; 2] {
    match s {
        State::B => [State::E, State::S],
        State::M => [State::M, State::B],
        State::S => [State::S, State::E],
        State::E => [State::B, State::M],
    }
}

fn prob_start(s: State) -> f64 {
    match s {
        State::B => -0.26268660809250016,
        State::E | State::M => -3.14e100,
        State::S => -1.4652633398537678,
    }
}

fn prob_trans(from: State, to: State) -> f64 {
    match (from, to) {
        (State::B, State::E) => -0.51082562376599,
        (State::B, State::M) => -0.916290731874155,
        (State::E, State::B) => -0.5897149736854513,
        (State::E, State::S) => -0.8085250474669937,
        (State::M, State::E) => -0.33344856811948514,
        (State::M, State::M) => -1.2603623820268226,
        (State::S, State::B) => -0.7211965654669841,
        (State::S, State::S) => -0.6658631448798212,
        _ => MIN_FLOAT,
    }
}

/// The likelier; on a tie the later state letter (Go sorts in reverse).
fn better(a: (f64, State), b: (f64, State)) -> (f64, State) {
    if b.0 > a.0 || (b.0 == a.0 && b.1 > a.1) { b } else { a }
}

fn viterbi(obs: &[char]) -> Vec<State> {
    let e = emit();
    let em = |s: State, c: char| e.get(&s).and_then(|m| m.get(&c.to_string())).copied().unwrap_or(MIN_FLOAT);
    let mut vtb: HashMap<State, f64> = HashMap::new();
    let mut path: HashMap<State, Vec<State>> = HashMap::new();
    let first = obs[0];
    for y in STATES {
        vtb.insert(y, em(y, first) + prob_start(y));
        path.insert(y, vec![y]);
    }
    for &ch in &obs[1..] {
        let mut next = HashMap::new();
        let mut new_path = HashMap::new();
        for y in STATES {
            let em_p = em(y, ch);
            let step = |y0: State| (vtb[&y0] + prob_trans(y0, y) + em_p, y0);
            let [s0, s1] = prev_status(y);
            let best = better(step(s0), step(s1));
            next.insert(y, best.0);
            let mut p = path[&best.1].clone();
            p.push(y);
            new_path.insert(y, p);
        }
        vtb = next;
        path = new_path;
    }
    let last = better((vtb[&State::E], State::E), (vtb[&State::S], State::S));
    path.remove(&last.1).unwrap_or_default()
}

fn hmm_internal(text: &str) -> Vec<String> {
    let runes: Vec<char> = text.chars().collect();
    let pos = viterbi(&runes);
    let mut out = vec![];
    let (mut begin, mut next) = (0, 0);
    for (i, ch) in runes.iter().enumerate() {
        match pos.get(i) {
            Some(State::B) => begin = i,
            Some(State::E) => {
                out.push(runes[begin..=i].iter().collect());
                next = i + 1;
            }
            Some(State::S) => {
                out.push(ch.to_string());
                next = i + 1;
            }
            _ => {}
        }
    }
    if next < runes.len() {
        out.push(runes[next..].iter().collect());
    }
    out
}

fn han_run() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\p{Han}+").expect("regex"))
}

fn skip_run() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([0-9]+\.[0-9]+|[a-zA-Z0-9]+)").expect("regex"))
}

/// gse's hmm.Cut: runs of Han by the model, numbers and Latin words whole,
/// the rest as it comes.
fn hmm_cut(input: &str) -> Vec<String> {
    let mut out = vec![];
    let mut text = input;
    loop {
        let cut = han_run().find(text);
        match cut {
            None if text.is_empty() => break,
            Some(m) if m.start() == 0 => {
                out.extend(hmm_internal(m.as_str()));
                text = &text[m.end()..];
                continue;
            }
            _ => {}
        }
        let non_cut = skip_run().find(text);
        match non_cut {
            None if text.is_empty() => break,
            Some(m) if m.start() == 0 => {
                text = &text[m.end()..];
                out.push(m.as_str().to_string());
                continue;
            }
            _ => {}
        }
        let at = match (cut, non_cut) {
            (Some(a), Some(b)) => Some(a.start().min(b.start())),
            (Some(a), None) => Some(a.start()),
            (None, Some(b)) => Some(b.start()),
            (None, None) => None,
        };
        let Some(at) = at else {
            out.push(text.to_string());
            break;
        };
        out.push(text[..at].to_string());
        text = &text[at..];
    }
    out
}

fn hmm_run(buf: &[char]) -> Vec<String> {
    let text: String = buf.iter().collect();
    match find(&text) {
        Some(f) if f > 0.0 => buf.iter().map(|c| c.to_string()).collect(),
        _ => hmm_cut(&text),
    }
}

/// gse's cutDAG: the dictionary's best path, single-character runs by HMM.
fn cut_dag(input: &str) -> Vec<String> {
    let runes: Vec<char> = go_lower(input).chars().collect();
    let routes = routes_of(&runes);
    let mut out = vec![];
    let mut buf: Vec<char> = vec![];
    let flush = |buf: &mut Vec<char>, out: &mut Vec<String>| {
        if buf.len() == 1 {
            out.push(buf[0].to_string());
        } else if buf.len() > 1 {
            out.extend(hmm_run(buf));
        }
        buf.clear();
    };
    let mut x = 0;
    while x < runes.len() {
        let y = routes[x].1 + 1;
        if y - x == 1 {
            buf.push(runes[x]);
        } else {
            flush(&mut buf, &mut out);
            out.push(runes[x..y].iter().collect());
        }
        x = y;
    }
    flush(&mut buf, &mut out);
    out
}

/// gse's CutSearch(text, true): each word, preceded by the two- and
/// three-character dictionary words inside it.
pub fn cut_search(text: &str) -> Vec<String> {
    let mut out = vec![];
    for word in cut_dag(text) {
        let runes: Vec<char> = word.chars().collect();
        for incr in [2, 3] {
            if runes.len() <= incr {
                continue;
            }
            for i in 0..=runes.len() - incr {
                let gram: String = runes[i..i + incr].iter().collect();
                if find(&gram).unwrap_or(0.0) > 0.0 {
                    out.push(gram);
                }
            }
        }
        out.push(word);
    }
    out
}

/// gse's CutAll: every dictionary word in the text.
pub fn cut_all(text: &str) -> Vec<String> {
    let runes: Vec<char> = go_lower(text).chars().collect();
    let dag = dag_of(&runes);
    let mut out = vec![];
    let mut start: isize = -1;
    for (k, ends) in dag.iter().enumerate() {
        if ends.len() == 1 && (k as isize) > start {
            out.push(runes[k..=ends[0]].iter().collect());
            start = ends[0] as isize;
            continue;
        }
        for &j in ends {
            if j > k {
                out.push(runes[k..=j].iter().collect());
                start = j as isize;
            }
        }
    }
    out
}
