use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "artifact_block")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub artifact_id: String,
    pub parent_id: Option<String>,
    pub order_key: String,
    #[sea_orm(column_name = "type")]
    pub block_type: String,
    #[sea_orm(column_type = "Text")]
    pub attrs: String,
    #[sea_orm(column_type = "Text")]
    pub spans: String,
    pub rev: i64,
    pub deleted: bool,
    pub updated_by: String,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
