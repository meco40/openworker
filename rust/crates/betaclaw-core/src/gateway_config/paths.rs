//! Port of `src/server/config/gateway/paths.ts`.
//!
//! `WORKSPACE_ROOT` in TypeScript is derived from `import.meta.url`, which has
//! no Rust equivalent. It is resolved from the `WORKSPACE_ROOT` / `PWD`
//! environment variables with `.` as the fallback, matching
//! `betaclaw_core::config::GatewayConfig::from_env` and
//! `betaclaw_core::db::default_db_path`. Every path returned here is normalised to
//! forward slashes: the Rust gateway only consumes them for SQLite and for the
//! `displayPath` response field, and `path.relative` already produces forward
//! slashes on Windows.

use std::env;
use std::path::Path;

pub use super::types::ConfigBackend;

/// Directory prefix used when `BETACLAW_CONFIG_PATH` names a non-absolute path
/// that is neither `.local/` nor `.betaclaw/` prefixed (`paths.ts:46`).
const WORKSPACE_LOCAL_DIR: &str = ".local";
const WORKSPACE_BETACLAW_DIR: &str = ".betaclaw";

/// Environment-driven resolution inputs, extracted so tests never have to mutate
/// process-wide environment state.
#[derive(Debug, Clone)]
pub struct PathResolver {
    pub workspace_root: String,
    pub config_path_env: Option<String>,
    pub config_backend_env: Option<String>,
    pub config_db_path_env: Option<String>,
    pub home_dir: Option<String>,
    pub cwd: String,
}

impl PathResolver {
    /// Reads the same environment variables as `paths.ts:37-67`.
    pub fn from_env() -> Self {
        let workspace_root = env::var("WORKSPACE_ROOT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                env::var("PWD")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_else(|| ".".to_string());

        Self {
            workspace_root,
            config_path_env: env::var("BETACLAW_CONFIG_PATH").ok(),
            config_backend_env: env::var("BETACLAW_CONFIG_BACKEND").ok(),
            config_db_path_env: env::var("GATEWAY_CONFIG_DB_PATH").ok(),
            // `paths.ts:9-11`: HOME wins over USERPROFILE.
            home_dir: env::var("HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    env::var("USERPROFILE")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                }),
            cwd: env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string()),
        }
    }

    /// A resolver rooted at `workspace_root` with every override unset, used by
    /// the default constructor and by tests.
    pub fn new(workspace_root: impl Into<String>) -> Self {
        let workspace_root = workspace_root.into();
        Self {
            workspace_root: workspace_root.clone(),
            config_path_env: None,
            config_backend_env: None,
            config_db_path_env: None,
            home_dir: None,
            cwd: workspace_root,
        }
    }

    /// `resolveGatewayConfigBackend` from `paths.ts:54-59`.
    pub fn resolve_backend(&self) -> ConfigBackend {
        let raw = self
            .config_backend_env
            .as_deref()
            .unwrap_or("db")
            .trim()
            .to_ascii_lowercase();
        if raw == "file" {
            ConfigBackend::File
        } else {
            ConfigBackend::Db
        }
    }

    /// `resolveGatewayConfigPath` from `paths.ts:36-52`.
    pub fn resolve_config_path(&self) -> String {
        if let Some(configured) = self
            .config_path_env
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if is_absolute(configured) {
                return normalize_path(configured);
            }
            let normalized = configured.replace('\\', "/");
            if normalized.starts_with(".local/") || normalized.starts_with(".betaclaw/") {
                return resolve_against(&self.workspace_root, &normalized);
            }
            return resolve_against(
                &self.workspace_root,
                &format!("{WORKSPACE_LOCAL_DIR}/{normalized}"),
            );
        }

        if let Some(home) = self
            .home_dir
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return join_all(&[home, WORKSPACE_BETACLAW_DIR, "betaclaw.json"]);
        }
        resolve_against(
            &self.workspace_root,
            &format!("{WORKSPACE_LOCAL_DIR}/betaclaw.json"),
        )
    }

    /// `resolveGatewayConfigDbPath` from `paths.ts:61-67`.
    pub fn resolve_config_db_path(&self) -> String {
        if let Some(configured) = self
            .config_db_path_env
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if is_absolute(configured) {
                return normalize_path(configured);
            }
            return resolve_against(&self.workspace_root, configured);
        }
        // The fallback is CWD-relative in the TypeScript source, not
        // workspace-relative: `path.resolve('.local/gateway-config.db')`.
        resolve_against(
            &self.cwd,
            &format!("{WORKSPACE_LOCAL_DIR}/gateway-config.db"),
        )
    }

    /// `toGatewayConfigDisplayPath` from `paths.ts:13-34`.
    pub fn to_display_path(&self, config_path: &str) -> String {
        let absolute = resolve_path(config_path, &self.cwd);

        if let Some(home) = self
            .home_dir
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            let home = resolve_path(home, &self.cwd);
            let home_relative = relative_path(&home, &absolute);
            if is_inside(&home_relative) {
                return format!("~/{}", normalize_display_path(&home_relative));
            }
        }

        let cwd = resolve_path(&self.cwd, &self.cwd);
        let cwd_relative = relative_path(&cwd, &absolute);
        if is_inside(&cwd_relative) {
            return format!("./{}", normalize_display_path(&cwd_relative));
        }

        format!(".../{}", basename(&absolute))
    }
}

/// `!relative.startsWith('..') && !path.isAbsolute(relative)` plus the non-empty
/// guard from `paths.ts:20-23`.
fn is_inside(relative: &str) -> bool {
    !relative.is_empty() && !relative.starts_with("..") && !is_absolute(relative)
}

/// `normalizeDisplayPath` from `paths.ts:4-6`.
fn normalize_display_path(raw: &str) -> String {
    raw.replace('\\', "/")
}

/// Splits a Windows drive prefix (`C:/`) or a POSIX root (`/`) from the segments.
fn split_root(path: &str) -> (String, Vec<&str>) {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        return (
            format!("{}:/", (bytes[0] as char).to_ascii_uppercase()),
            path[3..].split('/').filter(|s| !s.is_empty()).collect(),
        );
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return (
            format!("{}:/", (bytes[0] as char).to_ascii_uppercase()),
            path[2..].split('/').filter(|s| !s.is_empty()).collect(),
        );
    }
    if let Some(rest) = path.strip_prefix('/') {
        return (
            "/".to_string(),
            rest.split('/').filter(|s| !s.is_empty()).collect(),
        );
    }
    (
        String::new(),
        path.split('/').filter(|s| !s.is_empty()).collect(),
    )
}

/// Lexical `..`/`.` cleanup. `std::fs::canonicalize` cannot be used because the
/// target usually does not exist yet, exactly like the constraint documented in
/// `betaclaw_core::config::normalize_path`.
fn normalize_path(input: &str) -> String {
    let slashed = input.replace('\\', "/");
    let (root, segments) = split_root(&slashed);
    let mut stack: Vec<&str> = Vec::new();
    for segment in segments {
        match segment {
            "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("{root}{}", stack.join("/"))
}

/// `path.isAbsolute` for Windows and POSIX input.
pub fn is_absolute(path: &str) -> bool {
    let slashed = path.replace('\\', "/");
    let bytes = slashed.as_bytes();
    if slashed.starts_with('/') {
        return true;
    }
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// `path.resolve(base, candidate)` for an absolute `candidate` or a relative one.
fn resolve_against(base: &str, candidate: &str) -> String {
    if is_absolute(candidate) {
        normalize_path(candidate)
    } else {
        normalize_path(&format!("{}/{}", base.replace('\\', "/"), candidate))
    }
}

/// `path.resolve(candidate)` — resolved against `cwd`.
fn resolve_path(candidate: &str, cwd: &str) -> String {
    resolve_against(cwd, candidate)
}

/// `path.join(...)` followed by normalisation.
fn join_all(segments: &[&str]) -> String {
    normalize_path(&segments.join("/"))
}

/// `path.basename` for the normalised form used throughout this module.
fn basename(path: &str) -> String {
    let (root, segments) = split_root(path);
    if root.is_empty() {
        return path.to_string();
    }
    segments.last().copied().unwrap_or_default().to_string()
}
/// `path.relative(from, to)`. Both arguments must already be normalised.
///
/// Returns `to` unchanged when the two paths have different roots, which is what
/// `path.win32.relative` does for `C:/` versus `D:/`.
pub fn relative_path(from: &str, to: &str) -> String {
    let from_normalized = normalize_path(from);
    let to_normalized = normalize_path(to);
    let (from_root, from_segments) = split_root(&from_normalized);
    let (to_root, to_segments) = split_root(&to_normalized);
    if from_root != to_root {
        return to_normalized;
    }

    let mut common = 0;
    while common < from_segments.len()
        && common < to_segments.len()
        && from_segments[common] == to_segments[common]
    {
        common += 1;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in common..from_segments.len() {
        parts.push("..".to_string());
    }
    for segment in &to_segments[common..] {
        parts.push((*segment).to_string());
    }
    parts.join("/")
}

/// Resolves the display path using the ambient environment.
pub fn to_gateway_config_display_path(config_path: &str) -> String {
    PathResolver::from_env().to_display_path(config_path)
}

/// Reads `PERSONAS`-independent workspace root, exported for the persona slice.
pub fn workspace_root() -> String {
    PathResolver::from_env().workspace_root
}

/// True when `candidate` resolves inside `root`, porting `isPathWithinRoot` from
/// `src/server/security/pathBoundary.ts:12-17`.
pub fn is_path_within_root(candidate: &str, root: &str) -> bool {
    let relative = relative_path(root, candidate);
    relative.is_empty() || (!relative.starts_with("..") && !is_absolute(&relative))
}

/// The personas root directory default, mirroring
/// `resolvePersonasRootDir` from `src/server/personas/personaWorkspace.ts:161-167`.
pub fn personas_root_dir() -> String {
    let root = workspace_root();
    match env::var("PERSONAS_ROOT_PATH") {
        Ok(value) if !value.trim().is_empty() => resolve_path(value.trim(), &root),
        _ => resolve_against(&root, ".local/personas"),
    }
}

/// Ensures the parent directory of `path` exists, mirroring the `mkdir -p` calls
/// in `gatewayConfig.ts:191`.
pub fn ensure_parent_dir(path: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(root: &str) -> PathResolver {
        PathResolver::new(root)
    }

    #[test]
    fn normalises_dot_segments() {
        assert_eq!(normalize_path("./a/./b"), "a/b");
        assert_eq!(normalize_path("a/b/../c"), "a/c");
        assert_eq!(normalize_path("/var//lib/../lib/db"), "/var/lib/db");
        assert_eq!(normalize_path("C:\\work\\.local\\db"), "C:/work/.local/db");
    }

    #[test]
    fn detects_absolute_paths() {
        assert!(is_absolute("/etc/betaclaw.json"));
        assert!(is_absolute("C:/config/betaclaw.json"));
        assert!(is_absolute("C:\\config\\betaclaw.json"));
        assert!(!is_absolute(".local/betaclaw.json"));
        assert!(!is_absolute("betaclaw.json"));
    }

    #[test]
    fn relative_path_walks_up_and_down() {
        assert_eq!(relative_path("/a/b", "/a/b/c/d"), "c/d");
        assert_eq!(
            relative_path("/a/b/c", "/a/x"),
            "../../x",
            "two segments have to be walked up"
        );
        assert_eq!(relative_path("/a/b", "/a/b"), "");
        assert_eq!(relative_path("C:/a/b", "D:/a"), "D:/a", "different roots");
    }

    #[test]
    fn default_backend_is_db_and_file_must_be_explicit() {
        assert_eq!(resolver("/work").resolve_backend(), ConfigBackend::Db);

        let mut file = resolver("/work");
        file.config_backend_env = Some("FILE".into());
        assert_eq!(file.resolve_backend(), ConfigBackend::File);

        let mut garbage = resolver("/work");
        garbage.config_backend_env = Some("postgres".into());
        assert_eq!(
            garbage.resolve_backend(),
            ConfigBackend::Db,
            "unknown backends fall back to db, matching paths.ts:58"
        );
    }

    #[test]
    fn default_config_path_uses_the_workspace_root() {
        assert_eq!(
            resolver("/work").resolve_config_path(),
            "/work/.local/betaclaw.json"
        );
    }

    #[test]
    fn config_path_honours_the_betaclaw_home_layout() {
        let mut with_home = resolver("/work");
        with_home.home_dir = Some("/home/dev".into());
        assert_eq!(
            with_home.resolve_config_path(),
            "/home/dev/.betaclaw/betaclaw.json"
        );
    }

    #[test]
    fn configured_config_path_prefixes_decide_the_root() {
        let mut paths = resolver("/work");

        paths.config_path_env = Some("  custom.json  ".into());
        assert_eq!(
            paths.resolve_config_path(),
            "/work/.local/custom.json",
            "plain names land in .local"
        );

        paths.config_path_env = Some(".betaclaw/custom.json".into());
        assert_eq!(paths.resolve_config_path(), "/work/.betaclaw/custom.json");

        paths.config_path_env = Some("/etc/betaclaw.json".into());
        assert_eq!(paths.resolve_config_path(), "/etc/betaclaw.json");

        paths.config_path_env = Some("  ".into());
        assert_eq!(
            paths.resolve_config_path(),
            "/work/.local/betaclaw.json",
            "a blank override is ignored"
        );
    }

    #[test]
    fn db_path_default_is_cwd_relative() {
        let paths = resolver("/work");
        assert_eq!(
            paths.resolve_config_db_path(),
            "/work/.local/gateway-config.db"
        );

        let mut absolute = resolver("/work");
        absolute.config_db_path_env = Some("/var/lib/gateway.db".into());
        assert_eq!(absolute.resolve_config_db_path(), "/var/lib/gateway.db");

        absolute.config_db_path_env = Some("data/gateway.db".into());
        assert_eq!(
            absolute.resolve_config_db_path(),
            "/work/data/gateway.db",
            "relative overrides resolve against the workspace root"
        );
    }

    #[test]
    fn config_db_default_tracks_cwd_when_it_differs_from_the_workspace_root() {
        // `paths.ts:67` resolves the default with
        // `path.resolve('.local/gateway-config.db')`, i.e. against the process
        // cwd. WORKSPACE_ROOT only decides relative overrides. This is the
        // contract `GatewayConfig::from_env` must go through the PathResolver
        // for, instead of `resolve_db_path`.
        let mut paths = resolver("/work");
        paths.cwd = "/srv/gateway".into();
        assert_eq!(
            paths.resolve_config_db_path(),
            "/srv/gateway/.local/gateway-config.db"
        );

        paths.config_db_path_env = Some("data/gateway.db".into());
        assert_eq!(
            paths.resolve_config_db_path(),
            "/work/data/gateway.db",
            "relative overrides stay workspace-relative"
        );
    }

    #[test]
    fn display_path_prefers_home_then_cwd_then_basename() {
        let mut paths = resolver("/work");
        paths.home_dir = Some("/work/home/dev".into());
        assert_eq!(
            paths.to_display_path("/work/home/dev/.betaclaw/betaclaw.json"),
            "~/.betaclaw/betaclaw.json"
        );
        assert_eq!(
            paths.to_display_path("/work/.local/betaclaw.json"),
            "./.local/betaclaw.json"
        );
        assert_eq!(
            paths.to_display_path("/srv/other/betaclaw.json"),
            ".../betaclaw.json"
        );
    }

    #[test]
    fn display_path_does_not_treat_a_sibling_prefix_as_a_child() {
        // `/workspace-evil` must not render as `./-evil` under `/workspace`.
        let paths = resolver("/work");
        assert_eq!(
            paths.to_display_path("/work-evil/betaclaw.json"),
            ".../betaclaw.json"
        );
    }

    #[test]
    fn personas_root_defaults_below_the_workspace() {
        // The resolver helper is covered by the persona slice; here we only assert
        // the path helper it relies on.
        assert_eq!(
            resolve_against("/work", ".local/personas"),
            "/work/.local/personas"
        );
    }

    #[test]
    fn path_boundary_rejects_traversal() {
        assert!(is_path_within_root("/root/child/file.md", "/root"));
        assert!(!is_path_within_root("/root-evil/file.md", "/root"));
        assert!(!is_path_within_root("/etc/passwd", "/root"));
    }
}
