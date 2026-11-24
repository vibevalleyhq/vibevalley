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
