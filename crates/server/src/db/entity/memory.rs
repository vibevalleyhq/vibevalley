use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "memory")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub agent: String,
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    pub repo: Option<String>,
    pub session: Option<String>,
    pub author: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub recalled: i64,
    pub recalled_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
