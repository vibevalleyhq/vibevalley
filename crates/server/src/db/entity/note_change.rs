use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "note_change")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub note_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub seq: i64,
    pub kind: String,
    #[sea_orm(unique)]
    pub batch_id: Option<String>,
    pub actor: String,
    #[sea_orm(column_type = "Text")]
    pub targets: String,
    #[sea_orm(column_type = "Text")]
    pub payload: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
