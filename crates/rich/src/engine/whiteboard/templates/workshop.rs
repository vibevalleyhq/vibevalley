use crate::engine::whiteboard::model::{
    AnchorSide, ArrowHead, BoardDoc, BoardMeta, ElementKind, ElementRecord, GridStyle, Presence, PresenceColor, Rect2, TextAlign, TextVariant, WbFill,
};

use super::TemplateCopy;
use super::helpers::{connector_arrow, pill_el, sticky_el};

pub(super) fn build_workshop_doc(copy: &TemplateCopy) -> BoardDoc {
    let is_en = copy.user_label == "Dev";
    let (board_title, board_sub, c1_t, c2_t, c3_t, c4_t, c5_t) = if is_en {
        (
            "Client Portal launch workshop",
            "Fernbrook",
            "Who it's for",
            "What we promise",
            "Where it shows up",
            "Open risks",
            "Launch plan",
        )
    } else {
        (
            "客户门户启动工作坊",
            "VibeValley Studio",
            "面向人群",
            "核心承诺",
            "触达渠道",
            "待解风险",
            "上线计划",
        )
    };

    let who_texts = if is_en {
        [
            "Ops leads at 50-500 person shops",
            "Teams texting job photos to clients",
            "Fernbrook Pro accounts",
            "Office managers who send quotes",
        ]
    } else {
        [
            "50–500 人规模服务机构负责人",
            "习惯发现场照片给客户的团队",
            "Fernbrook 专业版账号",
            "负责报价跟进的运营主管",
        ]
    };

    let promise_texts = if is_en {
        [
            "Clients see the tech on the way",
            "Approve and pay from one link",
            "No app to download",
            "Every job photo in one place",
        ]
    } else {
        [
            "客户实时查看技师在途进度",
            "单条链接完成确认与支付",
            "无需下载额外客户端",
            "现场交付照片集中归档",
        ]
    };

    let channel_texts = if is_en {
        [
            "Launch webinar, Nov 18",
            "In-app banner for Pro admins",
            "Email to 4,200 admins",
            "Founder post on LinkedIn",
        ]
    } else {
        [
            "11 月 18 日上线发布会",
            "专业版管理员应用内横幅",
            "向 4,200 位管理员发邮件",
            "创始人动态专栏宣发",
        ]
    };

    let risk_texts = if is_en {
        [
            "Payments not live in Canada",
            "Support load in week one",
            "Help articles not translated",
            "No lead for the status page",
            "Decide Canada go-live by Nov 4",
            "Canned replies ready by Nov 11",
        ]
    } else {
        [
            "加拿大地区支付尚未开通",
            "首周客服咨询压力",
            "帮助中心暂未翻译",
            "状态页尚未定负责人",
            "11 月 4 日前拍板加拿大上线",
            "11 月 11 日前备好标准话术",
        ]
    };

    let (dates, milestones, leads, proposal_note) = if is_en {
        (
            ["Nov 4", "Nov 11", "Nov 18"],
            [
                "Beta opens to 20 Pro customers",
                "Help center live, support trained",
                "Webinar, email and in-app banner",
            ],
            ["Theo", "Nadia", "Rosa"],
            "First moves and dates are my proposals, not agreed. Tell me which to change.",
        )
    } else {
        (
            ["11月4日", "11月11日", "11月18日"],
            ["向 20 位专业版客户开启内测", "帮助中心上线，客服培训完成", "发布会、邮件及应用内横幅上线"],
            ["林舟", "苏晴", "陈默"],
            "初版排期与方案是我先拟的建议，还没定稿，告诉我需要改哪几项。",
        )
    };

    let mut elements = vec![
        ElementRecord::new(
            "ws-title",
            ElementKind::Text {
                x: 56.0,
                y: 26.0,
                w: 720.0,
                h: 44.0,
                variant: TextVariant::Title,
                label: board_title.to_owned(),
                highlight: None,
                icon: None,
                align: TextAlign::Left,
                font_size: Some(26.0),
                fill: None,
                color: None,
            },
        ),
        ElementRecord::new(
            "ws-sub",
            ElementKind::Text {
                x: 56.0,
                y: 68.0,
                w: 360.0,
                h: 24.0,
                variant: TextVariant::Subtitle,
                label: board_sub.to_owned(),
                highlight: None,
                icon: None,
                align: TextAlign::Left,
                font_size: Some(14.0),
                fill: None,
                color: None,
            },
        ),
        ElementRecord::new(
            "ws-c-who",
            ElementKind::Container {
                x: 56.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c1_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-promise",
            ElementKind::Container {
                x: 386.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c2_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-channel",
            ElementKind::Container {
                x: 716.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c3_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-risks",
            ElementKind::Container {
                x: 56.0,
                y: 428.0,
                w: 436.0,
                h: 224.0,
                title: c4_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-plan",
            ElementKind::Container {
                x: 522.0,
                y: 428.0,
                w: 494.0,
                h: 224.0,
                title: c5_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
    ];

    for (i, label) in who_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-who-{}", i + 1),
            Rect2::new(70.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Sun,
        ));
    }
    for (i, label) in promise_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-promise-{}", i + 1),
            Rect2::new(400.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Leaf,
        ));
    }
    for (i, label) in channel_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-chan-{}", i + 1),
            Rect2::new(730.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Water,
        ));
    }
    for (i, label) in risk_texts.iter().enumerate() {
        let col = (i % 3) as f64;
        let row = (i / 3) as f64;
        elements.push(sticky_el(
            &format!("ws-risk-{}", i + 1),
            Rect2::new(70.0 + col * 140.0, 442.0 + row * 102.0, 128.0, 90.0),
            label,
            WbFill::Berry,
        ));
    }

    for i in 0..3 {
        let row_y = 450.0 + i as f64 * 70.0;
        let tone = if i == 2 { WbFill::Lavender } else { WbFill::Side };
        elements.push(pill_el(
            &format!("ws-d-{}", i + 1),
            Rect2::new(540.0, row_y, 78.0, 36.0),
            dates[i],
            tone.clone(),
            false,
        ));
        elements.push(pill_el(
            &format!("ws-m-{}", i + 1),
            Rect2::new(642.0, row_y, 266.0, 36.0),
            milestones[i],
            tone.clone(),
            true,
        ));
        elements.push(pill_el(&format!("ws-l-{}", i + 1), Rect2::new(924.0, row_y, 74.0, 36.0), leads[i], tone, false));
        elements.push(connector_arrow(
            &format!("ws-hd-{}", i + 1),
            &format!("ws-d-{}", i + 1),
            AnchorSide::E,
            &format!("ws-m-{}", i + 1),
            AnchorSide::W,
            ArrowHead::None,
        ));
        elements.push(connector_arrow(
            &format!("ws-hl-{}", i + 1),
            &format!("ws-m-{}", i + 1),
            AnchorSide::E,
            &format!("ws-l-{}", i + 1),
            AnchorSide::W,
            ArrowHead::None,
        ));
    }
    elements.push(connector_arrow("ws-vd-1", "ws-d-1", AnchorSide::S, "ws-d-2", AnchorSide::N, ArrowHead::Arrow));
    elements.push(connector_arrow("ws-vd-2", "ws-d-2", AnchorSide::S, "ws-d-3", AnchorSide::N, ArrowHead::Arrow));

    let kenji_name = if is_en { "Kenji" } else { "林舟" };
    let rosa_name = if is_en { "Rosa" } else { "陈默" };

    BoardDoc {
        meta: BoardMeta {
            title: board_title.to_owned(),
            grid: GridStyle::Architectural,
            background: None,
        },
        elements,
        presences: vec![
            Presence {
                id: "kenji".to_owned(),
                name: kenji_name.to_owned(),
                color: PresenceColor::Leaf,
                x: 344.0,
                y: 388.0,
                rev: 1,
                ..Presence::default()
            },
            Presence {
                id: "rosa".to_owned(),
                name: rosa_name.to_owned(),
                color: PresenceColor::Blue,
                x: 906.0,
                y: 388.0,
                rev: 1,
                ..Presence::default()
            },
            Presence {
                id: "orchestrator".to_owned(),
                name: copy.orchestrator_label.to_owned(),
                color: PresenceColor::Coral,
                x: 212.0,
                y: 658.0,
                status: Some(proposal_note.to_owned()),
                rev: 1,
                ..Presence::default()
            },
        ],
        seq: 0,
    }
}
