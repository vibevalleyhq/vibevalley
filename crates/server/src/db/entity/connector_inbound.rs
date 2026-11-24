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
