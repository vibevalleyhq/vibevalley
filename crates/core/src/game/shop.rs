//! Farm shop catalog: sells ONLY yard decorations and issue templates.
//! Concurrency slots and execution productivity boosts are strictly forbidden.

use vibevalley_i18n::t;
use vibevalley_protocol::{IssueTemplate, JsNumber, RepoStack, ShopItem, ShopItemKind, TemplateBlank, YardDecoration, YardDecorationPlacement};

#[derive(Debug, Clone, Copy)]
pub struct DecorationSpec {
    pub asset: &'static str,
    pub x: f64,
    pub z: f64,
    pub yaw_deg: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ShopItemSpec {
    pub id: &'static str,
    pub kind: ShopItemKind,
    pub price: i64,
    pub decoration: Option<DecorationSpec>,
}

const SHOP_CATALOG: &[ShopItemSpec] = &[
    ShopItemSpec {
        id: "deco_stone_lantern",
        kind: ShopItemKind::Decoration,
        price: 40,
        decoration: Some(DecorationSpec {
            asset: "p_lantern",
            x: 2.15,
            z: -1.85,
            yaw_deg: 12.0,
            scale: 1.15,
        }),
    },
    ShopItemSpec {
        id: "deco_flower_border",
        kind: ShopItemKind::Decoration,
        price: 60,
        decoration: Some(DecorationSpec {
            asset: "p_flower_bush",
            x: -2.05,
            z: 0.75,
            yaw_deg: 18.0,
            scale: 1.05,
        }),
    },
    ShopItemSpec {
        id: "deco_bamboo_grove",
        kind: ShopItemKind::Decoration,
        price: 80,
        decoration: Some(DecorationSpec {
            asset: "p_bamboo",
            x: 4.85,
            z: -0.45,
            yaw_deg: -14.0,
            scale: 1.85,
        }),
    },
    ShopItemSpec {
        id: "deco_weeping_willow",
        kind: ShopItemKind::Decoration,
        price: 120,
        decoration: Some(DecorationSpec {
            asset: "p_willow",
            x: -1.65,
            z: 3.15,
            yaw_deg: 10.0,
            scale: 1.80,
        }),
    },
    ShopItemSpec {
        id: "deco_painted_boat",
        kind: ShopItemKind::Decoration,
        price: 160,
        decoration: Some(DecorationSpec {
            asset: "p_boat",
            x: 1.10,
            z: 4.45,
            yaw_deg: 24.0,
            scale: 1.18,
        }),
    },
    ShopItemSpec {
        id: "deco_rockery",
        kind: ShopItemKind::Decoration,
        price: 200,
        decoration: Some(DecorationSpec {
            asset: "p_terrace_hill",
            x: 3.05,
            z: -4.55,
            yaw_deg: -8.0,
            scale: 1.30,
        }),
    },
    ShopItemSpec {
        id: "tmpl_regression_guard",
        kind: ShopItemKind::Template,
        price: 45,
        decoration: None,
    },
    ShopItemSpec {
        id: "tmpl_edge_hardening",
        kind: ShopItemKind::Template,
        price: 65,
        decoration: None,
    },
    ShopItemSpec {
        id: "tmpl_subsystem_docs",
        kind: ShopItemKind::Template,
        price: 75,
        decoration: None,
    },
    ShopItemSpec {
        id: "tmpl_perf_profile",
        kind: ShopItemKind::Template,
        price: 90,
        decoration: None,
    },
    ShopItemSpec {
        id: "tmpl_security_audit",
        kind: ShopItemKind::Template,
        price: 110,
        decoration: None,
    },
];

pub fn shop_catalog() -> &'static [ShopItemSpec] {
    SHOP_CATALOG
}

pub fn shop_item(id: &str) -> Option<&'static ShopItemSpec> {
    SHOP_CATALOG.iter().find(|item| item.id == id)
}

fn fill_done_placeholders(raw: &str, stack: Option<&RepoStack>) -> String {
    let test = stack.and_then(|s| s.test.as_deref());
    let lint = stack.and_then(|s| s.lint.as_deref());
    let build = stack.and_then(|s| s.build.as_deref());
    let replace = |input: String, name: &str, cmd: Option<&str>| -> String {
        let token = format!("{{{name}}}");
        let value = match cmd {
            Some(c) => format!("`{c}`"),
            None => vibevalley_i18n::maybe(&format!("server.issue.template.commands.{name}")).unwrap_or_else(|| name.to_string()),
        };
        input.replace(&token, &value)
    };
    let out = replace(raw.to_string(), "test", test);
    let out = replace(out, "lint", lint);
    replace(out, "build", build)
}

pub fn template_for_spec(spec: &ShopItemSpec, stack: Option<&RepoStack>) -> Option<IssueTemplate> {
    if spec.kind != ShopItemKind::Template {
        return None;
    }
    let title = t(&format!("server.game.shop.items.{}.title", spec.id), &[]);
    let raw_done = t(&format!("server.game.shop.items.{}.done", spec.id), &[]);
    let done = fill_done_placeholders(&raw_done, stack);
    let text = t("server.issue.template.done", &[("title", title.clone().into()), ("done", done.clone().into())]);
    let blank = text.find('〔').and_then(|start| {
        let end = start + text[start..].find('〕')? + '〕'.len_utf8();
        let units = |b: usize| text[..b].encode_utf16().count() as f64;
        Some(TemplateBlank {
            start: JsNumber::from(units(start)),
            end: JsNumber::from(units(end)),
        })
    });
    Some(IssueTemplate {
        id: spec.id.to_string(),
        title,
        done,
        text,
        blank,
    })
}

pub fn shop_items_view(purchased: &[String], stack: Option<&RepoStack>) -> Vec<ShopItem> {
    SHOP_CATALOG
        .iter()
        .map(|spec| {
            let owned = purchased.iter().any(|id| id == spec.id);
            let decoration = spec.decoration.map(|d| YardDecorationPlacement {
                asset: d.asset.to_string(),
                x: JsNumber::from(d.x),
                z: JsNumber::from(d.z),
                yaw_deg: JsNumber::from(d.yaw_deg),
                scale: JsNumber::from(d.scale),
            });
            ShopItem {
                id: spec.id.to_string(),
                kind: spec.kind,
                title: t(&format!("server.game.shop.items.{}.title", spec.id), &[]),
                detail: t(&format!("server.game.shop.items.{}.detail", spec.id), &[]),
                price: spec.price,
                owned,
                decoration,
                template: template_for_spec(spec, stack),
            }
        })
        .collect()
}

pub fn yard_decorations_for(purchased: &[String]) -> Vec<YardDecoration> {
    SHOP_CATALOG
        .iter()
        .filter(|spec| spec.kind == ShopItemKind::Decoration && purchased.iter().any(|id| id == spec.id))
        .filter_map(|spec| {
            let d = spec.decoration?;
            Some(YardDecoration {
                id: spec.id.to_string(),
                asset: d.asset.to_string(),
                title: t(&format!("server.game.shop.items.{}.title", spec.id), &[]),
                x: JsNumber::from(d.x),
                z: JsNumber::from(d.z),
                yaw_deg: JsNumber::from(d.yaw_deg),
                scale: JsNumber::from(d.scale),
            })
        })
        .collect()
}

pub fn purchased_issue_templates(purchased: &[String], stack: Option<&RepoStack>) -> Vec<IssueTemplate> {
    SHOP_CATALOG
        .iter()
        .filter(|spec| spec.kind == ShopItemKind::Template && purchased.iter().any(|id| id == spec.id))
        .filter_map(|spec| template_for_spec(spec, stack))
        .collect()
}
