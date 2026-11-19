pub mod queries;

#[cfg(test)]
mod tests {
    use super::queries::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn project_queries_use_the_callers_transaction() -> Result<(), sqlx::Error> {
        let db = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await?;
        sqlx::raw_sql(include_str!("../schema.sql")).execute(&db).await?;
        sqlx::raw_sql("INSERT INTO projects VALUES (1,'/demo','original',0,1250); INSERT INTO terminals VALUES (1,'t1',0,'/demo',NULL,'');")
            .execute(&db)
            .await?;
        assert_eq!(get_project(&db, GetProjectParams { id: 1 }).await?.name, "original");
        let values = project_values(&db, ProjectValuesParams { id: 1 }).await?;
        assert_eq!(values.opened_seconds, 1.25);
        assert_eq!(values.name_bytes, b"original");
        assert!(matches!(get_project(&db, GetProjectParams { id: 2 }).await, Err(sqlx::Error::RowNotFound)));
        assert!(list_terminals(&db, ListTerminalsParams { project_id: 1 }).await?[0].title.is_none());

        let mut tx = db.begin().await?;
        sqlx::query("INSERT INTO projects VALUES (2,'/other','other',1,0)").execute(&mut *tx).await?;
        let terminals = project_terminals(&mut *tx).await?;
        assert_eq!(terminals.len(), 2);
        assert_eq!((terminals[0].id, terminals[0].terminal_id.as_deref()), (1, Some("t1")));
        assert_eq!((terminals[1].id, terminals[1].terminal_id.as_deref()), (2, None));
        assert_eq!(rename_project(&mut *tx, RenameProjectParams { id: 1, name: "updated".into() }).await?, 1);
        assert_eq!(get_project(&mut *tx, GetProjectParams { id: 1 }).await?.name, "updated");
        tx.rollback().await?;
        assert_eq!(list_projects(&db).await?[0].name, "original");
        assert_eq!(rename_project(&db, RenameProjectParams { id: 2, name: "unused".into() }).await?, 0);
        set_title(
            &db,
            SetTitleParams {
                id: "t1".into(),
                project_id: 1,
                title: Some("hello".into()),
            },
        )
        .await?;
        assert_eq!(
            list_terminals(&db, ListTerminalsParams { project_id: 1 }).await?[0].title.as_deref(),
            Some("hello")
        );
        set_title(
            &db,
            SetTitleParams {
                id: "t1".into(),
                project_id: 1,
                title: None,
            },
        )
        .await?;
        assert!(list_terminals(&db, ListTerminalsParams { project_id: 1 }).await?[0].title.is_none());
        Ok(())
    }
}
