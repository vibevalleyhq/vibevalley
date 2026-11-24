use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "artifact")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    pub body: String,
    pub artifact_type: Option<String>,
    pub is_default: bool,
    pub display: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub issue: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub version: i64,
    pub seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
