//! Port of `src/server/clawhub/clawhubService.ts`.
//!
//! The dependencies are passed to the constructor, as the TypeScript options
//! do. The DI registration (`getClawHubService`, `registerService`) is not
//! ported; the caller builds the service once and keeps it.
//!
//! `install`, `update` and `search` run the CLI and are async. `uninstall`,
//! `set_enabled` and the lockfile sync touch only files and SQLite, so they are
//! synchronous. The TypeScript `warnings` field was always empty and is dropped.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::cli::{ClawHubCli, CommandRunner};
use super::errors::{is_valid_slug, ClawHubError};
use super::prompt_builder::{build_clawhub_prompt_block, PromptLimits};
use super::repository::ClawHubRepository;
use super::search_parser::parse_clawhub_search_output;
use super::types::{SearchParseResult, SkillRow, SkillStatus, UpsertSkillInput};
use crate::stats::util::{iso_from_ms, js_truthy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallInput {
    pub slug: String,
    pub version: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInput {
    pub slug: Option<String>,
    pub all: bool,
    pub version: Option<String>,
    pub force: bool,
}

pub struct ClawHubService<R: CommandRunner> {
    cli: ClawHubCli<R>,
    repository: ClawHubRepository,
    workspace_dir: PathBuf,
}

/// `normalizeSkillSlugOrThrow`.
fn normalize_slug(value: &str) -> Result<String, ClawHubError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(ClawHubError::Input("Skill slug is required.".into()));
    }
    if !is_valid_slug(normalized) {
        return Err(ClawHubError::Input(format!(
            "Invalid ClawHub skill slug: {normalized}"
        )));
    }
    Ok(normalized.to_string())
}

/// `resolveSkillPath`: the directory of a skill under `<workspace>/skills`. A
/// validated slug is one path component, so the check only guards the join.
fn resolve_skill_path(workspace_dir: &Path, slug: &str) -> Result<PathBuf, ClawHubError> {
    let skills_root = workspace_dir.join("skills");
    let skill_path = skills_root.join(slug);
    if skill_path.parent() != Some(skills_root.as_path()) {
        return Err(ClawHubError::Input(format!(
            "Invalid ClawHub skill slug: {slug}"
        )));
    }
    Ok(skill_path)
}

/// `readJsonFile`: `None` when the file is missing or not valid JSON.
fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), ClawHubError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

/// `toIsoFromEpoch`: a positive finite epoch in milliseconds, as ISO text.
fn to_iso_from_epoch(value: Option<f64>) -> Option<String> {
    let value = value?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    iso_from_ms(value as i64)
}

/// `parseJsonObject`: `None` for empty or invalid output, and for JSON `null`.
fn parse_json_output(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .filter(|value| !value.is_null())
}

/// `version?.trim()` as a non-empty value.
fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn remove_path(path: &Path) -> Result<(), ClawHubError> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

impl<R: CommandRunner> ClawHubService<R> {
    pub fn new(cli: ClawHubCli<R>, repository: ClawHubRepository, workspace_dir: PathBuf) -> Self {
        Self {
            cli,
            repository,
            workspace_dir,
        }
    }

    fn lock_path(&self) -> PathBuf {
        self.workspace_dir.join(".clawhub").join("lock.json")
    }

    /// `search`: the limit is clamped to 1 through 200.
    pub async fn search(&self, query: &str, limit: i64) -> Result<SearchParseResult, ClawHubError> {
        let args = vec![
            "--limit".to_string(),
            limit.clamp(1, 200).to_string(),
            query.trim().to_string(),
        ];
        let result = self.cli.run("search", &args).await?;
        Ok(parse_clawhub_search_output(&result.stdout))
    }

    /// `explore`: the CLI's JSON output, or an empty list when there is none.
    pub async fn explore(&self, limit: i64, sort: &str) -> Result<Value, ClawHubError> {
        let sort = match sort.trim() {
            "" => "newest",
            trimmed => trimmed,
        };
        let args = vec![
            "--json".to_string(),
            "--limit".to_string(),
            limit.clamp(1, 200).to_string(),
            "--sort".to_string(),
            sort.to_string(),
        ];
        let result = self.cli.run("explore", &args).await?;
        Ok(parse_json_output(&result.stdout).unwrap_or_else(|| Value::Array(Vec::new())))
    }

    /// `install`: `--force` only when asked, then `--version`, then the slug.
    pub async fn install(&self, input: &InstallInput) -> Result<Vec<SkillRow>, ClawHubError> {
        let slug = normalize_slug(&input.slug)?;
        let mut args = Vec::new();
        if input.force {
            args.push("--force".to_string());
        }
        if let Some(version) = non_empty_trimmed(input.version.as_deref()) {
            args.push("--version".to_string());
            args.push(version);
        }
        args.push(slug);
        self.cli.run("install", &args).await?;
        self.sync_installed_from_lockfile()
    }

    /// `update`: either `--all` or one normalised slug, then the optional flags.
    pub async fn update(&self, input: &UpdateInput) -> Result<Vec<SkillRow>, ClawHubError> {
        let mut args = Vec::new();
        if input.all {
            args.push("--all".to_string());
        } else {
            args.push(normalize_slug(input.slug.as_deref().unwrap_or(""))?);
        }
        if let Some(version) = non_empty_trimmed(input.version.as_deref()) {
            args.push("--version".to_string());
            args.push(version);
        }
        if input.force {
            args.push("--force".to_string());
        }
        self.cli.run("update", &args).await?;
        self.sync_installed_from_lockfile()
    }

    /// `uninstall`: removes the lock entry, the directory and the row. Fails with
    /// `NotFound` when none of the three exists.
    pub fn uninstall(&self, slug: &str) -> Result<Vec<SkillRow>, ClawHubError> {
        let slug = normalize_slug(slug)?;
        let lock_path = self.lock_path();
        let mut lock_skills: Map<String, Value> = read_json_file(&lock_path)
            .as_ref()
            .and_then(|raw| raw.get("skills"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let had_lock_entry = js_truthy(lock_skills.get(&slug));
        let skill_path = resolve_skill_path(&self.workspace_dir, &slug)?;
        let had_skill_directory = skill_path.exists();
        let had_repository_row = self.repository.get_skill(&slug)?.is_some();

        if !had_lock_entry && !had_skill_directory && !had_repository_row {
            return Err(ClawHubError::NotFound(format!(
                "ClawHub skill not found: {slug}"
            )));
        }
        if had_lock_entry {
            lock_skills.remove(&slug);
            write_json_file(
                &lock_path,
                &serde_json::json!({ "version": 1, "skills": Value::Object(lock_skills) }),
            )?;
        }
        if had_skill_directory {
            remove_path(&skill_path)?;
        }
        self.repository.delete_skill(&slug)?;
        self.sync_installed_from_lockfile()
    }

    /// `syncInstalledFromLockfile`: mirrors the lockfile into the table. Entries
    /// with unsafe slugs are skipped. When every entry is unsafe, the table is
    /// left alone; when the lockfile lists no skills, the table is emptied.
    pub fn sync_installed_from_lockfile(&self) -> Result<Vec<SkillRow>, ClawHubError> {
        let lock_path = self.lock_path();
        if !lock_path.exists() {
            return self.repository.list_skills();
        }
        let raw = match read_json_file(&lock_path) {
            Some(raw) if raw.is_object() => raw,
            _ => return self.repository.list_skills(),
        };
        let Some(entries) = raw.get("skills").and_then(Value::as_object) else {
            return self.repository.list_skills();
        };

        let mut invalid_count = 0usize;
        let mut kept: Vec<String> = Vec::new();
        for (slug, entry) in entries {
            let safe_slug = slug.trim();
            if safe_slug.is_empty() || !is_valid_slug(safe_slug) {
                invalid_count += 1;
                continue;
            }
            kept.push(safe_slug.to_string());

            let meta = read_json_file(
                &self
                    .workspace_dir
                    .join("skills")
                    .join(safe_slug)
                    .join("_meta.json"),
            );
            let title = meta
                .as_ref()
                .and_then(|meta| meta.get("title"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(safe_slug)
                .to_string();
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|version| !version.is_empty())
                .unwrap_or("unknown")
                .to_string();

            self.repository.upsert_skill(&UpsertSkillInput {
                slug: safe_slug.to_string(),
                version,
                title,
                status: SkillStatus::Installed,
                enabled: None,
                local_path: format!("skills/{safe_slug}"),
                installed_at: to_iso_from_epoch(entry.get("installedAt").and_then(Value::as_f64)),
                last_action_at: None,
                last_error: None,
            })?;
        }

        if invalid_count > 0 && kept.is_empty() {
            return self.repository.list_skills();
        }
        self.repository.delete_not_in(&kept)?;
        self.repository.list_skills()
    }

    /// `setEnabled`: `NotFound` when the skill has no row.
    pub fn set_enabled(&self, slug: &str, enabled: bool) -> Result<SkillRow, ClawHubError> {
        let normalized = normalize_slug(slug)?;
        if !self.repository.set_enabled(&normalized, enabled)? {
            return Err(ClawHubError::NotFound(format!(
                "ClawHub skill not found: {normalized}"
            )));
        }
        self.repository
            .get_skill(&normalized)?
            .ok_or_else(|| ClawHubError::NotFound(format!("ClawHub skill not found: {normalized}")))
    }

    /// `getPromptBlock`: the advisory block for the enabled skills.
    pub fn prompt_block(&self) -> Result<String, ClawHubError> {
        build_clawhub_prompt_block(
            &self.workspace_dir,
            &self.repository,
            PromptLimits::default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clawhub::cli::{ClawHubCliOptions, ExecError, ExecOutput};
    use std::future::Future;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Records the arguments of every call and answers with fixed stdout.
    #[derive(Clone, Default)]
    struct RecordingRunner {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl CommandRunner for RecordingRunner {
        fn execute(
            &self,
            _file: &str,
            args: &[String],
            _cwd: &Path,
            _timeout: Duration,
        ) -> impl Future<Output = Result<ExecOutput, ExecError>> + Send {
            self.calls.lock().expect("calls").push(args.to_vec());
            async {
                Ok(ExecOutput {
                    stdout: "[]".into(),
                    stderr: String::new(),
                })
            }
        }
    }

    fn workspace() -> PathBuf {
        std::env::temp_dir().join(format!(
            "clawhub-service-{}",
            crate::stats::util::short_uuid()
        ))
    }

    fn service(root: &Path) -> (ClawHubService<RecordingRunner>, RecordingRunner) {
        let runner = RecordingRunner::default();
        let options = ClawHubCliOptions {
            workdir: root.to_path_buf(),
            timeout: Duration::from_secs(5),
            binary: "clawhub".into(),
            exe_dir: root.join("node-bin"),
            windows: false,
        };
        let cli = ClawHubCli::new(runner.clone(), options);
        let repository = ClawHubRepository::in_memory().expect("repository");
        (
            ClawHubService::new(cli, repository, root.to_path_buf()),
            runner,
        )
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(path, content).expect("write");
    }

    #[tokio::test]
    async fn install_puts_force_before_version_and_the_slug_last() {
        let root = workspace();
        let (service, runner) = service(&root);
        let input = InstallInput {
            slug: " weather ".into(),
            version: Some("1.2.0".into()),
            force: true,
        };
        service.install(&input).await.expect("install");
        let call = runner.calls.lock().expect("calls")[0].clone();
        assert_eq!(
            call[3..],
            ["install", "--force", "--version", "1.2.0", "weather"]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_invalid_slug_never_reaches_the_cli() {
        let root = workspace();
        let (service, runner) = service(&root);
        let error = service
            .install(&InstallInput {
                slug: "bad/slug".into(),
                version: None,
                force: false,
            })
            .await
            .expect_err("rejected");
        assert_eq!(error.http_status(), 400);
        assert!(runner.calls.lock().expect("calls").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn update_all_ignores_the_slug() {
        let root = workspace();
        let (service, runner) = service(&root);
        service
            .update(&UpdateInput {
                slug: None,
                all: true,
                version: None,
                force: false,
            })
            .await
            .expect("update");
        assert_eq!(
            runner.calls.lock().expect("calls")[0][3..],
            ["update", "--all"]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_mirrors_the_lockfile_and_skips_unsafe_slugs() {
        let root = workspace();
        let (service, _) = service(&root);
        write(
            &root.join(".clawhub").join("lock.json"),
            r#"{"version":1,"skills":{
                "weather":{"version":"2.0.0","installedAt":1700000000000},
                "bad slug!":{"version":"9.9.9"}
            }}"#,
        );
        write(
            &root.join("skills/weather/_meta.json"),
            r#"{"title":"Weather"}"#,
        );

        let rows = service.sync_installed_from_lockfile().expect("sync");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "weather");
        assert_eq!(rows[0].title, "Weather");
        assert_eq!(rows[0].version, "2.0.0");
        assert_eq!(rows[0].local_path, "skills/weather");
        assert_eq!(
            rows[0].installed_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lockfile_with_only_unsafe_slugs_keeps_the_table() {
        let root = workspace();
        let (service, _) = service(&root);
        service
            .repository
            .upsert_skill(&UpsertSkillInput {
                slug: "old".into(),
                version: "1".into(),
                title: "old".into(),
                status: SkillStatus::Installed,
                enabled: None,
                local_path: "skills/old".into(),
                installed_at: None,
                last_action_at: None,
                last_error: None,
            })
            .expect("seed");
        write(
            &root.join(".clawhub").join("lock.json"),
            r#"{"skills":{"bad slug!":{}}}"#,
        );
        let rows = service.sync_installed_from_lockfile().expect("sync");
        assert_eq!(rows.len(), 1, "nothing safe to keep, so nothing is deleted");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_removes_the_lock_entry_the_directory_and_the_row() {
        let root = workspace();
        let (service, _) = service(&root);
        let lock = root.join(".clawhub").join("lock.json");
        write(
            &lock,
            r#"{"version":1,"skills":{"weather":{"version":"1"},"other":{"version":"1"}}}"#,
        );
        write(&root.join("skills/weather/SKILL.md"), "body");
        service
            .repository
            .upsert_skill(&UpsertSkillInput {
                slug: "weather".into(),
                version: "1".into(),
                title: "weather".into(),
                status: SkillStatus::Installed,
                enabled: None,
                local_path: "skills/weather".into(),
                installed_at: None,
                last_action_at: None,
                last_error: None,
            })
            .expect("seed");

        service.uninstall("weather").expect("uninstall");

        assert!(!root.join("skills/weather").exists());
        let written = read_json_file(&lock).expect("lock rewritten");
        assert_eq!(written["version"], 1);
        assert!(written["skills"].get("weather").is_none());
        assert!(written["skills"].get("other").is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstalling_an_unknown_skill_is_not_found() {
        let root = workspace();
        let (service, _) = service(&root);
        let error = service.uninstall("ghost").expect_err("not found");
        assert_eq!(error.http_status(), 404);
        assert_eq!(error.code(), Some("CLAW_NOT_FOUND"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_enabled_requires_an_existing_row() {
        let root = workspace();
        let (service, _) = service(&root);
        assert_eq!(
            service
                .set_enabled("ghost", true)
                .expect_err("missing")
                .http_status(),
            404
        );
        let _ = fs::remove_dir_all(&root);
    }
}
