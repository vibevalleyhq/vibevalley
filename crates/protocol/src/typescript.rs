//! The contract in TypeScript: every type in `contract/` written to
//! `packages/protocol/src/<module>/shapes.gen.ts` by `ts-rs`, one file per
//! module, importing what it names from the others. `tests/typescript.rs`
//! fails when the files differ from these; `vp run protocol:ts` writes them.
//!
//! Each `contract/<module>.rs` ends with [`module!`] listing what it declares:
//! a type left out fails the render when another type names it. A unit enum
//! becomes `XValues` (its strings, in order) and `type X = (typeof XValues)[number]`.
//!
//! Ids are plain `String`s in Rust and branded strings in TypeScript: a
//! field holding one says so with `#[ts(as = "crate::typescript::IssueId")]`
//! (`Option<…>`, `Vec<…>` around it as the field has).

use std::collections::BTreeMap;

use ts_rs::{Config, TS};

/// One declaration in a module's file, with its doc comment.
pub struct Decl {
    pub name: String,
    pub text: String,
}

/// What one `contract/<module>.rs` declares.
pub struct Module {
    pub name: &'static str,
    pub decls: Vec<Decl>,
}

/// Lists a contract module's types (deriving `TS`) and type aliases for its TypeScript file.
macro_rules! module {
    ($name:literal; types: [$($t:ident),* $(,)?]; aliases: [$($a:ident),* $(,)?];) => {
        pub(crate) fn ts_module(cfg: &ts_rs::Config) -> $crate::typescript::Module {
            $crate::typescript::Module {
                name: $name,
                decls: vec![
                    $($crate::typescript::declare::<$t>(cfg),)*
                    $($crate::typescript::alias::<$a>(stringify!($a), cfg),)*
                ],
            }
        }
    };
}
pub(crate) use module;

macro_rules! brands {
    ($($(#[doc = $doc:literal])* $name:ident),* $(,)?) => {
        $(
            $(#[doc = $doc])*
            pub struct $name;

            impl TS for $name {
                type WithoutGenerics = Self;
                type OptionInnerType = Self;

                fn name(_: &Config) -> String {
                    stringify!($name).to_owned()
                }

                fn inline(cfg: &Config) -> String {
                    Self::name(cfg)
                }

                fn docs() -> Option<String> {
                    let lines: &[&str] = &[$($doc),*];
                    (!lines.is_empty()).then(|| format!("/**{} */\n", lines.join("\n *")))
                }

                fn decl(_: &Config) -> String {
                    format!("type {0} = Branded<\"{0}\">;", stringify!($name))
                }
            }
        )*

        fn brand_decls(cfg: &Config) -> Vec<Decl> {
            vec![$(declare::<$name>(cfg)),*]
        }
    };
}

brands! {
    /// An issue's id (not its number).
    IssueId,
    /// A session's id: w1, w2…, for the whole life of the farm.
    SessionId,
    /// A note's id.
    NoteId,
    /// A suggested change to a note file.
    SuggestionId,
    MessageId,
}

const BRANDED: &str = "declare const brand: unique symbol;\n\
/** A string that is one kind of id: two kinds do not mix, and a plain string becomes one only where the kind is known (schema.ts). */\n\
export type Branded<K extends string> = string & { readonly [brand]: K };";

pub fn declare<T: TS + ?Sized>(cfg: &Config) -> Decl {
    let name = T::ident(cfg);
    let docs = T::docs().unwrap_or_default();
    let decl = T::decl(cfg);
    let text = match string_union(&decl) {
        Some(values) => format!(
            "{docs}export const {name}Values = [{}] as const;\n{docs}export type {name} = (typeof {name}Values)[number];",
            values.join(", ")
        ),
        None => format!("{docs}export {decl}"),
    };
    Decl { name, text }
}

pub fn alias<T: TS + ?Sized>(name: &str, cfg: &Config) -> Decl {
    Decl {
        name: name.to_owned(),
        text: format!("export type {name} = {};", T::inline(cfg)),
    }
}

fn note_types_decl() -> Decl {
    let names = crate::contract::all_type_specs()
        .iter()
        .map(|spec| serde_json::to_string(spec.note_type.as_str()).expect("serialize note type"))
        .collect::<Vec<_>>()
        .join(", ");
    Decl {
        name: "NOTE_TYPES".to_owned(),
        text: format!("export const NOTE_TYPES = [{names}] as const;"),
    }
}

fn note_type_specs_decl() -> Decl {
    let mut text = String::from("export const NOTE_TYPE_SPECS: Readonly<Record<NoteType, NoteTypeSpec>> = {\n");
    for spec in crate::contract::all_type_specs() {
        let key = serde_json::to_string(spec.note_type.as_str()).expect("serialize note type");
        let slug = serde_json::to_string(spec.slug).expect("serialize slug");
        let entry_path = serde_json::to_string(spec.entry_path).expect("serialize entryPath");
        let entry_mime = serde_json::to_string(spec.entry_mime).expect("serialize entryMime");
        let default_dirs = serde_json::to_string(spec.default_dirs).expect("serialize defaultDirs");
        let export_suffix = serde_json::to_string(spec.export_suffix).expect("serialize exportSuffix");
        text.push_str(&format!(
            "  {key}: {{ noteType: {key}, slug: {slug}, entryPath: {entry_path}, entryMime: {entry_mime}, defaultDirs: {default_dirs}, exportSuffix: {export_suffix} }},\n"
        ));
    }
    text.push_str("};");
    Decl {
        name: "NOTE_TYPE_SPECS".to_owned(),
        text,
    }
}

/// The strings of `type X = "a" | "b";`, when that is all it is.
fn string_union(decl: &str) -> Option<Vec<&str>> {
    let body = decl.split_once(" = ")?.1.strip_suffix(';')?;
    let values: Vec<&str> = body.split(" | ").collect();
    values
        .iter()
        .all(|v| v.len() >= 2 && v.starts_with('"') && v.ends_with('"') && !v[1..v.len() - 1].contains('"'))
        .then_some(values)
}

const BUILTIN: &[&str] = &["Array", "Record", "Partial", "Branded", "Readonly"];

/// Every `shapes.gen.ts` and `endpoints.gen.ts`, as (path from the repository root, contents).
pub fn files() -> Vec<(String, String)> {
    let mut out = shape_files();
    out.push(("packages/protocol/src/endpoints.gen.ts".to_owned(), endpoint_table()));
    out
}

/// The endpoint table the server serves, for `api.test.ts` to hold `api.ts`'s to: op, who may call it, what it is
/// about, its dry run.
fn endpoint_table() -> String {
    let quote = |s: &str| format!("\"{s}\"");
    let list = |items: Vec<String>| format!("[{}]", items.join(", "));
    let mut out = String::from(HEADER);
    out.push_str("export const servedEndpoints = [\n");
    for e in crate::contract::ENDPOINTS {
        let can = list(e.can.iter().map(|c| quote(c.as_str())).collect());
        let about = list(e.about.iter().map(|a| quote(a)).collect());
        let dry = e.dry_run.map_or(String::new(), |d| format!(", dryRun: {}", quote(d)));
        out.push_str(&format!("  {{ op: {}, can: {can}, about: {about}{dry} }},\n", quote(e.op)));
    }
    out.push_str("] as const;\n\nexport const servedSubscriptions = [\n");
    for s in crate::contract::SUBSCRIPTIONS {
        let can = list(s.can.iter().map(|c| quote(c.as_str())).collect());
        out.push_str(&format!("  {{ name: {}, can: {can} }},\n", quote(s.name)));
    }
    out.push_str("] as const;\n");
    out
}

const HEADER: &str = "// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.\n\n";

fn shape_files() -> Vec<(String, String)> {
    let cfg = Config::new().with_large_int("number");
    let mut modules = crate::contract::ts_modules(&cfg);
    for m in &mut modules {
        if m.name == "common" {
            let mut decls = brand_decls(&cfg);
            decls.append(&mut m.decls);
            m.decls = decls;
        }
        if m.name == "note" {
            let specs_pos = m.decls.iter().position(|d| d.name == "NoteTypeSpec").map_or(m.decls.len(), |i| i + 1);
            m.decls.insert(specs_pos, note_types_decl());
            m.decls.insert(specs_pos + 1, note_type_specs_decl());
        }
    }
    fold_tags(&mut modules);
    let mut home: BTreeMap<&str, &str> = BTreeMap::new();
    for m in &modules {
        for d in &m.decls {
            if let Some(other) = home.insert(&d.name, m.name) {
                panic!("{} is declared in both {other} and {}", d.name, m.name);
            }
        }
    }
    modules
        .iter()
        .map(|m| {
            let mut imports: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
            let mut unknown = Vec::new();
            let own: Vec<&str> = m.decls.iter().map(|d| d.name.as_str()).collect();
            let mut named: Vec<&str> = m.decls.iter().flat_map(|d| type_names(&d.text)).collect();
            named.sort_unstable();
            named.dedup();
            for n in named {
                if own.contains(&n) || BUILTIN.contains(&n) || n.ends_with("Values") && own.contains(&&n[..n.len() - 6]) {
                    continue;
                }
                match home.get(n) {
                    Some(from) => imports.entry(from).or_default().push(n),
                    None => unknown.push(n),
                }
            }
            assert!(
                unknown.is_empty(),
                "contract/{}.rs names {unknown:?}, which no contract module lists in its typescript::module!",
                m.name
            );
            let mut out = String::from(HEADER);
            for (from, names) in &imports {
                out.push_str(&format!("import type {{ {} }} from \"../{from}/shapes.gen\";\n", names.join(", ")));
            }
            if !imports.is_empty() {
                out.push('\n');
            }
            if m.name == "common" {
                out.push_str(BRANDED);
                out.push_str("\n\n");
            }
            for (i, decl) in m.decls.iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                for line in decl.text.lines() {
                    out.push_str(line.trim_end());
                    out.push('\n');
                }
            }
            (format!("packages/protocol/src/{}/shapes.gen.ts", m.name), out)
        })
        .collect()
}

/// A tagged union's member written `{ "kind": "once" } & CronWhenOnce` becomes
/// `CronWhenOnce`, its declaration carrying `"kind": "once"` (or every value
/// it is tagged with, `"kind": "opened" | "split"`): the views name a member by
/// its type and read the tag off it. A member under two tag keys keeps the
/// intersection.
fn fold_tags(modules: &mut [Module]) {
    let mut tags: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    let mut mixed = Vec::new();
    for d in modules.iter().flat_map(|m| &m.decls) {
        for (key, value, member) in tagged_members(&d.text) {
            let (k, values) = tags.entry(member.to_owned()).or_insert_with(|| (key.to_owned(), Vec::new()));
            if k != key {
                mixed.push(member.to_owned());
            } else if !values.iter().any(|v| v == value) {
                values.push(value.to_owned());
            }
        }
    }
    let object =
        |d: &Decl| d.text.contains(&format!("export type {} = {{ ", d.name)) || d.text.contains(&format!("export type {} = Record<symbol, never>;", d.name));
    tags.retain(|member, _| !mixed.contains(member) && modules.iter().flat_map(|m| &m.decls).any(|d| d.name == *member && object(d)));
    for d in modules.iter_mut().flat_map(|m| &mut m.decls) {
        for (member, (key, values)) in &tags {
            for value in values {
                d.text = d.text.replace(&format!("{{ \"{key}\": \"{value}\" }} & {member}"), member);
            }
        }
        if let Some((key, values)) = tags.get(&d.name) {
            let tag = format!("\"{key}\": {}", values.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(" | "));
            let empty = format!("export type {} = Record<symbol, never>;", d.name);
            let open = format!("export type {} = {{ ", d.name);
            d.text = if d.text.contains(&empty) {
                d.text.replace(&empty, &format!("{open}{tag}, }};"))
            } else {
                d.text.replacen(&open, &format!("{open}{tag}, "), 1)
            };
        }
    }
    // The member's own union now repeats it once per tag value.
    for d in modules.iter_mut().flat_map(|m| &mut m.decls) {
        for (member, (_, values)) in &tags {
            if values.len() > 1 {
                let twice = format!("{member} | {member}");
                while d.text.contains(&twice) {
                    d.text = d.text.replace(&twice, member);
                }
            }
        }
    }
}

/// Every `{ "key": "value" } & Member` in `text`.
fn tagged_members(text: &str) -> Vec<(&str, &str, &str)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("{ \"") {
        rest = &rest[i + 3..];
        let Some((key, after)) = rest.split_once("\": \"") else { break };
        let Some((value, after)) = after.split_once("\" } & ") else { continue };
        let end = after.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(after.len());
        if !key.contains('"') && !value.contains('"') && end > 0 {
            out.push((key, value, &after[..end]));
        }
    }
    out
}

/// The capitalized names `text` uses outside its comments and string literals.
fn type_names(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if text[i..].starts_with("/**") || text[i..].starts_with("/*") => {
                i += text[i..].find("*/").map_or(bytes.len() - i, |e| e + 2);
            }
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if c.is_ascii_uppercase() {
                    out.push(&text[start..i]);
                }
            }
            _ => i += 1,
        }
    }
    out
}
