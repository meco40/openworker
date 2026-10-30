//! Live driver regression check; creates only a connection-local temporary table.
use betaclaw_core::world_model::{
    db::{PgExecutor, PgStatement, PgValue},
    driver::{PgPoolSettings, SqlxPgExecutor},
};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let executor = SqlxPgExecutor::connect(&PgPoolSettings {
        database_url: std::env::var("BETACLAW_TEST_DATABASE_URL")?,
        pool_max: 1,
        pool_idle_timeout_ms: 1000,
    })
    .await?;
    let session = executor.connect().await?;
    session
        .query(PgStatement::new(
            "CREATE TYPE pg_temp.driver_probe_enum AS ENUM ('ready')",
        ))
        .await?;
    session.query(PgStatement::new("CREATE TEMP TABLE driver_probe (id UUID, at TIMESTAMPTZ, payload JSONB, n SMALLINT, label TEXT, ids UUID[], confidence REAL)")).await?;
    let id = "12345678-1234-1234-1234-123456789abc";
    let result = session
        .query(PgStatement::with_params(
            "INSERT INTO driver_probe VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            vec![
                PgValue::Text(id.into()),
                PgValue::Text("2026-10-29T00:00:00.000Z".into()),
                PgValue::Text("{\"ok\":true}".into()),
                PgValue::Int64(3),
                PgValue::Text("scope".into()),
                PgValue::TextArray(vec![id.into()]),
                PgValue::Float64(0.25),
            ],
        ))
        .await?;
    assert_eq!(result.rows[0],json!({"id":id,"at":"2026-10-29T00:00:00.000Z","payload":{"ok":true},"n":3,"label":"scope","ids":[id],"confidence":0.25}).as_object().unwrap().clone());
    let cast = session
        .query(PgStatement::with_params(
            "SELECT $1::int4 + 1 AS value",
            vec![PgValue::Text("3".into())],
        ))
        .await?;
    assert_eq!(cast.rows[0]["value"], 4);
    let enumeration = session
        .query(PgStatement::with_params(
            "SELECT $1::pg_temp.driver_probe_enum AS value",
            vec![PgValue::Text("ready".into())],
        ))
        .await?;
    assert_eq!(enumeration.rows[0]["value"], "ready");
    let null = session
        .query(PgStatement::with_params(
            "INSERT INTO driver_probe (id,at,payload) VALUES ($1,$2,$3) RETURNING id,at,payload",
            vec![PgValue::Null, PgValue::Null, PgValue::Null],
        ))
        .await?;
    assert!(null.rows[0].values().all(|value| value.is_null()));
    let void = session
        .query(PgStatement::new("SELECT pg_sleep(0) AS result"))
        .await?;
    assert!(void.rows[0]["result"].is_null());
    session.release();
    executor.close().await;
    println!("PostgreSQL driver: typed parameters, UUID/array/JSON/timestamp/null/VOID passed");
    Ok(())
}
