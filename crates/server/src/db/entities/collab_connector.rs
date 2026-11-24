pub mod connector_account {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "connector_account")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub connector: String,
        #[sea_orm(column_type = "Text")]
        pub secrets: String,
        pub user_id: Option<String>,
        pub pair_code: Option<String>,
        pub cursor: String,
        #[sea_orm(column_type = "Text", nullable)]
        pub reply_context: Option<String>,
        pub last_inbound: Option<i64>,
        pub paused_until: Option<i64>,
        pub connected_at: i64,
        pub channel_id: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod connector_inbound {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "connector_inbound")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub seq: i64,
        pub connector: String,
        pub ext_id: String,
        pub from_id: String,
        #[sea_orm(column_type = "Text")]
        pub body: String,
        #[sea_orm(column_type = "Text")]
        pub reply: String,
        #[sea_orm(column_type = "Text")]
        pub quoted: String,
        pub message_id: Option<String>,
        pub created_at: i64,
        pub delivered: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod connector_outbox {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "connector_outbox")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub seq: i64,
        pub connector: String,
        pub message_id: String,
        #[sea_orm(column_type = "Text")]
        pub body: String,
        pub state: String,
        pub ext_id: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub error: Option<String>,
        pub created_at: i64,
        pub sent_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
