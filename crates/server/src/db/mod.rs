use sea_orm::{DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr, SqliteTransactionMode, TransactionOptions, TransactionTrait};

pub(crate) mod entities;
pub(crate) mod error;
pub(crate) mod migration;

pub(crate) async fn next_seq_async(db: &impl sea_orm::ConnectionTrait, name: &str, at_least: i64) -> Result<i64, DbErr> {
    use sea_orm::sea_query::{Expr, OnConflict};
    use sea_orm::{ActiveValue::Set, EntityTrait, ExprTrait};

    let model = entities::shared::seq_counter::ActiveModel {
        name: Set(name.to_owned()),
        last_number: Set(at_least + 1),
    };
    let current = Expr::col((entities::shared::seq_counter::Entity, entities::shared::seq_counter::Column::LastNumber));
    let next_expr = Expr::expr(Expr::case(current.clone().gt(at_least), current).finally(at_least)).add(1);
    let on_conflict = OnConflict::column(entities::shared::seq_counter::Column::Name)
        .value(entities::shared::seq_counter::Column::LastNumber, next_expr)
        .to_owned();
    let saved = entities::shared::seq_counter::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_with_returning(db)
        .await?;
    Ok(saved.last_number)
}

/// Opens a write transaction, using `BEGIN IMMEDIATE` on SQLite so writers serialize at begin.
pub(crate) async fn begin_write_tx(conn: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    let opts = match conn.get_database_backend() {
        DatabaseBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await
}

pub(crate) async fn write_tx<T, E>(
    db: &DatabaseConnection,
    map_err: fn(DbErr) -> E,
    f: impl for<'a> FnOnce(&'a DatabaseTransaction) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send + 'a>> + Send,
) -> Result<T, E> {
    let tx = begin_write_tx(db).await.map_err(map_err)?;
    match f(&tx).await {
        Ok(val) => {
            tx.commit().await.map_err(map_err)?;
            Ok(val)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

#[cfg(test)]
pub(crate) mod test_pg {
    use std::io::Write;
    use std::path::PathBuf;

    use sea_orm::{ConnectionTrait, Database};

    pub(crate) struct EphemeralPostgres {
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        port: u16,
        _temp: tempfile::TempDir,
    }

    impl EphemeralPostgres {
        pub(crate) fn start() -> Option<Self> {
            let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;
            let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;

            let temp = tempfile::tempdir().ok()?;
            let data_dir = temp.path().join("pgdata");
            let sock_dir = temp.path().join("sock");
            std::fs::create_dir_all(&sock_dir).ok()?;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            drop(listener);

            let init = std::process::Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
                .output()
                .ok()?;
            assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

            let conf = format!(
                "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
                sock_dir.display()
            );
            std::fs::OpenOptions::new()
                .append(true)
                .open(data_dir.join("postgresql.conf"))
                .unwrap()
                .write_all(conf.as_bytes())
                .unwrap();

            let log = temp.path().join("postgres.log");
            let start = std::process::Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log)
                .args(["-w", "start"])
                .output()
                .ok()?;
            assert!(
                start.status.success(),
                "pg_ctl start failed: {}\nlog:\n{}",
                String::from_utf8_lossy(&start.stderr),
                std::fs::read_to_string(&log).unwrap_or_default()
            );

            Some(Self {
                data_dir,
                pg_ctl,
                port,
                _temp: temp,
            })
        }

        pub(crate) fn create_database(&self, db_name: &str) {
            let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
            let name = db_name.to_owned();
            vibevalley_runtime::rt::block_on(async move {
                let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
                db.execute_unprepared(&format!("CREATE DATABASE \"{name}\""))
                    .await
                    .expect("create test database");
                db.close().await.expect("close admin db");
            });
        }

        pub(crate) fn db_url(&self, db_name: &str) -> String {
            format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
        }
    }

    impl Drop for EphemeralPostgres {
        fn drop(&mut self) {
            let _ = std::process::Command::new(&self.pg_ctl)
                .arg("-D")
                .arg(&self.data_dir)
                .args(["-m", "immediate", "-w", "stop"])
                .output();
        }
    }
}
