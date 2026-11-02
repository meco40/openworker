//! Credential store for local users.
//!
//! Port of `src/server/auth/userStore.ts`. The SQLite schema and the password
//! hash format are byte-compatible, so an account created by the TypeScript
//! backend authenticates against the Rust gateway and vice versa.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{open, OpenOptions};

/// A user without the password hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Set both AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD.")]
    IncompleteBootstrapCredentials,
    #[error("The public default admin password is unsafe; choose a unique password.")]
    PublicDefaultPassword,
    #[error("Configure AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD for the first admin.")]
    MissingBootstrapCredentials,
    #[error("configuration error: {0}")]
    Config(String),
}

/// scrypt parameters. `crypto.scryptSync(password, salt, 64)` defaults to
/// N=16384, r=8, p=1 with a 64-byte derived key.
const SCRYPT_LOG_N: u8 = 14;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SCRYPT_KEY_LEN: usize = 64;
const SALT_LEN: usize = 16;

/// The publicly documented default password. Login with it is always refused,
/// even when a stale account still carries that hash.
const PUBLIC_DEFAULT_PASSWORD: &str = "admin1234";
/// sha256("admin1234"). The test `public_default_hash_constant_is_correct` pins
/// this against an independent computation so the constant cannot rot.
const PUBLIC_DEFAULT_PASSWORD_HASH: &str =
    "ac9689e2272427085e35b9d3e3e8bed88cb3434828b43b86fc0596cad4c6e270";

/// Bootstrap inputs read from the environment by `ensure_default_user`.
#[derive(Debug, Clone, Default)]
pub struct BootstrapConfig {
    pub default_email: String,
    pub default_password: String,
    pub default_name: String,
    pub node_env: String,
}

pub struct AuthUserStore {
    connection: Connection,
    /// Cached dummy hash so a miss costs the same as a wrong password.
    dummy_hash: Option<String>,
}

impl AuthUserStore {
    /// Opens the store and applies the same DDL as the TypeScript version.
    pub fn open(db_path: &str, bootstrap: &BootstrapConfig) -> Result<Self, AuthStoreError> {
        let connection = open(OpenOptions::new(db_path))?;
        let mut store = Self {
            connection,
            dummy_hash: None,
        };
        store.migrate()?;
        store.ensure_default_user(bootstrap)?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), AuthStoreError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS auth_users (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              name TEXT,
              email TEXT UNIQUE,
              emailVerified TEXT,
              image TEXT
            );
            CREATE TABLE IF NOT EXISTS accounts (
              userId TEXT NOT NULL,
              type TEXT NOT NULL,
              provider TEXT NOT NULL,
              providerAccountId TEXT NOT NULL,
              refresh_token TEXT,
              access_token TEXT,
              expires_at INTEGER,
              token_type TEXT,
              scope TEXT,
              id_token TEXT,
              session_state TEXT,
              PRIMARY KEY (provider, providerAccountId)
            );
            CREATE TABLE IF NOT EXISTS sessions (
              sessionToken TEXT PRIMARY KEY,
              userId TEXT NOT NULL,
              expires TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verification_tokens (
              identifier TEXT NOT NULL,
              token TEXT NOT NULL,
              expires TEXT NOT NULL,
              PRIMARY KEY (identifier, token)
            );
            "#,
        )?;
        Ok(())
    }

    fn ensure_default_user(&mut self, bootstrap: &BootstrapConfig) -> Result<(), AuthStoreError> {
        let email = bootstrap.default_email.trim().to_ascii_lowercase();
        let password = bootstrap.default_password.trim().to_string();

        if email.is_empty() && password.is_empty() {
            if bootstrap.node_env == "production" && self.user_count()? == 0 {
                return Err(AuthStoreError::MissingBootstrapCredentials);
            }
            return Ok(());
        }
        if email.is_empty() || password.is_empty() {
            return Err(AuthStoreError::IncompleteBootstrapCredentials);
        }
        if verify_password_hash(&password, PUBLIC_DEFAULT_PASSWORD_HASH).ok {
            return Err(AuthStoreError::PublicDefaultPassword);
        }

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let existing: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT id, password_hash FROM auth_users WHERE email = ?1",
                params![email],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        // Bootstrap credentials can recover an old default account without
        // deleting it, matching `ensureDefaultUser` in the TypeScript store.
        if let Some((existing_id, existing_hash)) = existing.as_ref() {
            if verify_password_hash(PUBLIC_DEFAULT_PASSWORD, existing_hash).ok {
                self.connection.execute(
                    "UPDATE auth_users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
                    params![hash_password(&password), now, existing_id],
                )?;
            }
        }

        let new_id = format!("usr-{}", uuid::Uuid::new_v4());
        self.connection.execute(
            "INSERT OR IGNORE INTO auth_users (id, email, name, password_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new_id,
                email,
                if bootstrap.default_name.trim().is_empty() {
                    "Local Admin".to_string()
                } else {
                    bootstrap.default_name.trim().to_string()
                },
                hash_password(&password),
                now,
                now
            ],
        )?;

        let auth_user: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT id, name, email FROM auth_users WHERE email = ?1",
                params![email],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((id, name, user_email)) = auth_user {
            self.connection.execute(
                "INSERT OR IGNORE INTO users (id, name, email, emailVerified, image)
                 VALUES (?1, ?2, ?3, NULL, NULL)",
                params![id, name, user_email],
            )?;
        }
        Ok(())
    }

    fn user_count(&self) -> Result<i64, AuthStoreError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM auth_users", [], |row| row.get(0))?)
    }

    /// Verifies credentials. Returns `None` for unknown accounts and for wrong
    /// passwords so the caller cannot distinguish the two.
    pub fn verify_credentials(
        &mut self,
        email: &str,
        password: &str,
    ) -> Result<Option<AuthUser>, AuthStoreError> {
        if verify_password_hash(password, PUBLIC_DEFAULT_PASSWORD_HASH).ok {
            return Ok(None);
        }
        let normalized = email.trim().to_ascii_lowercase();
        let row: Option<(String, String, String, String)> = self
            .connection
            .query_row(
                "SELECT id, email, name, password_hash FROM auth_users WHERE email = ?1",
                params![normalized],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;

        let Some((id, email, name, stored_hash)) = row else {
            // Hash against a dummy so the timing does not reveal account existence.
            let dummy = self.dummy_hash.clone().unwrap_or_else(random_hash);
            let _ = verify_password_hash(password, &dummy);
            self.dummy_hash = Some(dummy);
            return Ok(None);
        };

        let verification = verify_password_hash(password, &stored_hash);
        if !verification.ok {
            return Ok(None);
        }

        if verification.needs_upgrade {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            self.connection.execute(
                "UPDATE auth_users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
                params![hash_password(password), now, id],
            )?;
        }

        Ok(Some(AuthUser { id, email, name }))
    }

    /// The id of the account with this email, matched case-insensitively.
    pub fn user_id_for_email(&self, email: &str) -> Result<Option<String>, AuthStoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT id FROM auth_users WHERE email = ?1",
                params![email.trim().to_ascii_lowercase()],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Test and maintenance helper; not part of the login contract.
    pub fn set_password(&mut self, user_id: &str, password: &str) -> Result<(), AuthStoreError> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.connection.execute(
            "UPDATE auth_users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
            params![hash_password(password), now, user_id],
        )?;
        Ok(())
    }
}

/// Hashes a password with the same format as `hashPassword()` in `userStore.ts`.
pub fn hash_password(password: &str) -> String {
    let salt = random_hex(SALT_LEN);
    let derived = scrypt_hash(password, &salt);
    format!("scrypt${salt}${derived}")
}

/// Outcome of a password hash verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verification {
    pub ok: bool,
    pub needs_upgrade: bool,
}

/// Verifies a stored hash, supporting the legacy plain SHA-256 form.
pub fn verify_password_hash(password: &str, stored_hash: &str) -> Verification {
    // Legacy fallback for hashes created by older local dev builds.
    if stored_hash.len() == 64 && stored_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        let candidate = sha256_hex(password);
        return Verification {
            ok: candidate.eq_ignore_ascii_case(stored_hash),
            needs_upgrade: true,
        };
    }

    let mut parts = stored_hash.split('$');
    let scheme = parts.next().unwrap_or_default();
    let salt = parts.next().unwrap_or_default();
    let derived = parts.next().unwrap_or_default();
    if scheme != "scrypt" || salt.is_empty() || derived.is_empty() || parts.next().is_some() {
        return Verification {
            ok: false,
            needs_upgrade: false,
        };
    }

    let candidate = scrypt_hash(password, salt);
    Verification {
        ok: constant_time_eq(candidate.as_bytes(), derived.as_bytes()),
        needs_upgrade: false,
    }
}

fn scrypt_hash(password: &str, salt: &str) -> String {
    let salt_bytes = salt.as_bytes();
    let mut output = vec![0u8; SCRYPT_KEY_LEN];
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)
        .expect("static scrypt parameters are valid");
    scrypt::scrypt(password.as_bytes(), salt_bytes, &params, &mut output)
        .expect("scrypt with valid parameters cannot fail");
    bytes_to_hex(&output)
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    bytes_to_hex(&hasher.finalize())
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn random_hex(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    fill_random(&mut bytes);
    bytes_to_hex(&bytes)
}

fn random_hash() -> String {
    hash_password(&random_hex(SALT_LEN))
}

fn fill_random(buffer: &mut [u8]) {
    use std::io::Read;
    // /dev/urandom on Linux, BCryptGenRandom semantics are not portable; the
    // gateway runs in a container, so /dev/urandom is available.
    match std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(buffer)) {
        Ok(()) => {}
        Err(_) => {
            for (index, slot) in buffer.iter_mut().enumerate() {
                *slot = uuid::Uuid::new_v4().as_u128().to_le_bytes()[index % 16];
            }
        }
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    if left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bootstrap(email: &str, password: &str) -> BootstrapConfig {
        BootstrapConfig {
            default_email: email.to_string(),
            default_password: password.to_string(),
            default_name: "Admin".to_string(),
            node_env: "test".to_string(),
        }
    }

    #[test]
    fn hashes_round_trip() {
        let hash = hash_password("correct horse battery staple");
        assert!(hash.starts_with("scrypt$"));
        assert!(verify_password_hash("correct horse battery staple", &hash).ok);
        assert!(!verify_password_hash("wrong", &hash).ok);
    }

    #[test]
    fn rejects_malformed_hash() {
        assert!(!verify_password_hash("x", "not-a-hash").ok);
        assert!(!verify_password_hash("x", "scrypt$onlysalt").ok);
    }

    #[test]
    fn legacy_sha256_hash_is_upgraded() {
        let legacy = sha256_hex("legacy-password");
        let verification = verify_password_hash("legacy-password", &legacy);
        assert!(verification.ok);
        assert!(verification.needs_upgrade);
    }

    #[test]
    fn public_default_hash_constant_is_correct() {
        // The constant is what makes the public default password unusable. If
        // it ever drifts, the guard silently stops working.
        assert_eq!(
            sha256_hex(PUBLIC_DEFAULT_PASSWORD),
            PUBLIC_DEFAULT_PASSWORD_HASH
        );
    }

    #[test]
    fn public_default_password_is_refused() {
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("a@b.c", "uniquepass-1")).unwrap();
        assert!(store
            .verify_credentials("a@b.c", "admin1234")
            .unwrap()
            .is_none());
    }

    #[test]
    fn bootstrap_admin_id_is_found_by_email() {
        let store = AuthUserStore::open(":memory:", &bootstrap("Admin@Example.com", "s3cret-pass"))
            .unwrap();
        let id = store
            .user_id_for_email("admin@example.com")
            .unwrap()
            .expect("bootstrap admin");
        assert!(id.starts_with("usr-"));
        assert_eq!(store.user_id_for_email("nobody@example.com").unwrap(), None);
    }

    #[test]
    fn bootstrap_creates_and_authenticates_user() {
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("Admin@Example.com ", "s3cret-pass"))
                .unwrap();
        let user = store
            .verify_credentials("admin@example.com", "s3cret-pass")
            .unwrap();
        assert!(user.is_some());
        assert_eq!(user.unwrap().name, "Admin");
        assert!(store
            .verify_credentials("admin@example.com", "nope")
            .unwrap()
            .is_none());
        assert!(store
            .verify_credentials("unknown@example.com", "nope")
            .unwrap()
            .is_none());
    }

    #[test]
    fn refuses_public_default_bootstrap_password() {
        let Err(error) = AuthUserStore::open(":memory:", &bootstrap("a@b.c", "admin1234")) else {
            panic!("the public default password must be refused");
        };
        assert!(matches!(error, AuthStoreError::PublicDefaultPassword));
    }

    #[test]
    fn refuses_partial_bootstrap_credentials() {
        let Err(error) = AuthUserStore::open(":memory:", &bootstrap("a@b.c", "")) else {
            panic!("partial bootstrap credentials must be refused");
        };
        assert!(matches!(
            error,
            AuthStoreError::IncompleteBootstrapCredentials
        ));
    }

    /// Writes a hash directly, the way a row from an older installation looks.
    fn set_hash(store: &AuthUserStore, email: &str, hash: &str) {
        store
            .connection
            .execute(
                "UPDATE auth_users SET password_hash = ?1 WHERE email = ?2",
                params![hash, email],
            )
            .unwrap();
    }

    fn stored_hash(store: &AuthUserStore, email: &str) -> String {
        store
            .connection
            .query_row(
                "SELECT password_hash FROM auth_users WHERE email = ?1",
                params![email],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn wrong_password_on_legacy_hash_does_not_upgrade_it() {
        // Port of "rejects a wrong password and does not upgrade the stored hash"
        // (tests/unit/auth/user-store-legacy-verify.test.ts).
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("a@b.c", "uniquepass-1")).unwrap();
        let legacy = sha256_hex("legacy-password");
        set_hash(&store, "a@b.c", &legacy);

        assert!(store
            .verify_credentials("a@b.c", "wrong-password")
            .unwrap()
            .is_none());
        assert_eq!(stored_hash(&store, "a@b.c"), legacy);
    }

    #[test]
    fn successful_login_upgrades_legacy_hash_in_the_database() {
        // Port of "upgrades a legacy hash to scrypt on a successful login". The
        // older test only checked the verification flag; this checks the row.
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("a@b.c", "uniquepass-1")).unwrap();
        set_hash(&store, "a@b.c", &sha256_hex("legacy-password"));

        assert!(store
            .verify_credentials("a@b.c", "legacy-password")
            .unwrap()
            .is_some());
        let upgraded = stored_hash(&store, "a@b.c");
        assert!(upgraded.starts_with("scrypt$"), "hash was not upgraded");
        assert!(store
            .verify_credentials("a@b.c", "legacy-password")
            .unwrap()
            .is_some());
    }

    #[test]
    fn unknown_email_is_hashed_against_a_dummy_for_timing() {
        // Port of "runs a password hash for unknown emails so timing does not
        // reveal accounts". The dummy hash is created on the first miss and reused.
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("a@b.c", "uniquepass-1")).unwrap();
        assert!(store.dummy_hash.is_none());
        assert!(store
            .verify_credentials("nobody@b.c", "anything")
            .unwrap()
            .is_none());
        assert!(store.dummy_hash.is_some());
    }

    #[test]
    fn development_without_bootstrap_credentials_creates_no_admin() {
        // Port of "does not create an implicit admin in development".
        let store = AuthUserStore::open(":memory:", &bootstrap("", "")).unwrap();
        assert_eq!(store.user_count().unwrap(), 0);
    }

    #[test]
    fn production_without_bootstrap_credentials_fails_on_first_start() {
        // Port of "requires explicit credentials for the first production admin".
        let production = BootstrapConfig {
            node_env: "production".to_string(),
            ..bootstrap("", "")
        };
        let Err(error) = AuthUserStore::open(":memory:", &production) else {
            panic!("production must not start without an admin");
        };
        assert!(matches!(error, AuthStoreError::MissingBootstrapCredentials));
    }

    #[test]
    fn explicit_bootstrap_recovers_an_account_still_on_the_public_default() {
        // Port of "blocks an old default password and recovers that account with
        // explicit credentials". The public default is refused as a new password,
        // but an existing account that still carries it is re-keyed.
        let mut store =
            AuthUserStore::open(":memory:", &bootstrap("a@b.c", "uniquepass-1")).unwrap();
        set_hash(&store, "a@b.c", &sha256_hex(PUBLIC_DEFAULT_PASSWORD));
        assert!(store
            .verify_credentials("a@b.c", PUBLIC_DEFAULT_PASSWORD)
            .unwrap()
            .is_none());

        store
            .ensure_default_user(&bootstrap("a@b.c", "fresh-pass-2"))
            .unwrap();
        assert!(store
            .verify_credentials("a@b.c", "fresh-pass-2")
            .unwrap()
            .is_some());
        assert!(store
            .verify_credentials("a@b.c", PUBLIC_DEFAULT_PASSWORD)
            .unwrap()
            .is_none());
    }

    #[test]
    fn reopens_existing_account() {
        let mut first = AuthUserStore::open(":memory:", &bootstrap("a@b.c", "first-pass")).unwrap();
        let user = first
            .verify_credentials("a@b.c", "first-pass")
            .unwrap()
            .unwrap();
        drop(first);

        let path = std::env::temp_dir().join(format!("betaclaw-auth-{}.db", uuid::Uuid::new_v4()));
        let db_path = path.to_string_lossy().to_string();
        AuthUserStore::open(&db_path, &bootstrap("a@b.c", "first-pass")).unwrap();
        let mut second =
            AuthUserStore::open(&db_path, &bootstrap("other@b.c", "second-pass")).unwrap();
        // Reopening with a different bootstrap account must not disturb the first.
        assert!(second
            .verify_credentials("a@b.c", "first-pass")
            .unwrap()
            .is_some());
        let _ = std::fs::remove_file(&path);
        let _ = user;
    }
}
