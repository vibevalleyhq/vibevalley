use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "artifact_collab")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub artifact_id: String,
    #[sea_orm(column_type = "Blob")]
    pub snapshot: Vec<u8>,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
