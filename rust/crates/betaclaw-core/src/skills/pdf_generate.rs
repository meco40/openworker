//! Port of `src/server/skills/handlers/pdfGenerate.ts`.
//!
//! Turns HTML or Markdown into a PDF in `{workspace}/output`, or in `.local/pdf-output` when
//! no workspace is set. Converters are tried in order: headless Chromium, then wkhtmltopdf.
//! Without a converter the HTML file is the result.
//!
//! Blocking: each converter may run for up to 30 s. Call this from a blocking task.
//!
//! Deviations:
//! - Converters start without a shell. TypeScript builds `execSync` command strings, and the
//!   paths are passed here as separate arguments.
//! - Converters are looked up on `PATH` and are not run as a probe. TypeScript runs `where` or
//!   `which`.
//! - Chromium keeps `--no-sandbox`, as TypeScript does. Chromium renders HTML the model wrote,
//!   so the flag widens what a crafted page can reach. It stays for parity and is listed as a
//!   risk in the report.
//! - The TypeScript `.replace(/\.pdf$/i, '')` after the name sanitiser never matches, because
//!   the sanitiser already removed every dot. It is left out.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Map, Value};

use super::types::{arg_string, js_trim, SkillDispatchContext, SkillError};
use crate::safe_error_message;

const DEFAULT_OUTPUT_DIR: &str = ".local/pdf-output";
const CONVERTER_TIMEOUT: Duration = Duration::from_secs(30);
const CHROMIUM_CANDIDATES: [&str; 8] = [
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

static HTML_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<[a-z].*>").expect("static regex"));
static STRONG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("static regex"));
static EMPHASIS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*(.+?)\*").expect("static regex"));
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`(.+?)`").expect("static regex"));

/// Which converters to try, and whether they are available.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Converters {
    pub chromium: Option<PathBuf>,
    pub try_wkhtmltopdf: bool,
}

impl Converters {
    /// Looks for the converters on this machine, as the TypeScript handler does.
    pub fn detect() -> Self {
        Self {
            chromium: CHROMIUM_CANDIDATES
                .iter()
                .copied()
                .find_map(find_executable),
            try_wkhtmltopdf: true,
        }
    }
}

/// `pdfGenerateHandler`. Blocking, see the module note.
pub fn pdf_generate(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
) -> Result<Value, SkillError> {
    generate(args, ctx, &Converters::detect())
}

/// The handler with the converters given, so tests do not depend on the host.
pub(crate) fn generate(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    converters: &Converters,
) -> Result<Value, SkillError> {
    // `String(args.content || args.html || args.markdown || '').trim()`
    let raw = ["content", "html", "markdown"]
        .iter()
        .map(|key| arg_string(args, key))
        .find(|text| !text.is_empty())
        .unwrap_or_default();
    let content = js_trim(&raw).to_string();
    if content.is_empty() {
        return Ok(json!({ "error": "content (or html / markdown) is required" }));
    }

    let requested = arg_string(args, "filename");
    let name_source: &str = if requested.is_empty() {
        "document"
    } else {
        requested.as_str()
    };
    let filename = sanitize_filename(name_source);

    let output_dir = match ctx.workspace_cwd.as_deref().filter(|dir| !dir.is_empty()) {
        Some(workspace) => Path::new(workspace).join("output"),
        None => PathBuf::from(DEFAULT_OUTPUT_DIR),
    };
    fs::create_dir_all(&output_dir).map_err(io_error)?;

    let html_body = if HTML_TAG.is_match(&content) {
        content
    } else {
        markdown_to_html(&content)
    };
    let html_path = output_dir.join(format!("{filename}.html"));
    let pdf_path = output_dir.join(format!("{filename}.pdf"));
    fs::write(&html_path, wrap_in_html_page(&html_body, &filename)).map_err(io_error)?;
    let html_text = html_path.to_string_lossy().into_owned();
    let pdf_text = pdf_path.to_string_lossy().into_owned();

    if let Some(chromium) = &converters.chromium {
        let chromium_args = [
            "--headless".to_string(),
            "--disable-gpu".to_string(),
            "--no-sandbox".to_string(),
            format!("--print-to-pdf={pdf_text}"),
            html_text.clone(),
        ];
        if run_converter(chromium, &chromium_args) {
            return Ok(converted("chromium", &pdf_text, &html_text));
        }
    }
    if converters.try_wkhtmltopdf {
        let wkhtml_args = [html_text.clone(), pdf_text.clone()];
        if run_converter(Path::new("wkhtmltopdf"), &wkhtml_args) {
            return Ok(converted("wkhtmltopdf", &pdf_text, &html_text));
        }
    }

    Ok(json!({
        "status": "html_only",
        "method": "none",
        "htmlPath": html_text,
        "message": format!(
            "No PDF converter (chromium/wkhtmltopdf) found. HTML saved at {html_text}. Use shell_execute to convert manually or install a PDF converter."
        ),
    }))
}

fn converted(method: &str, pdf_path: &str, html_path: &str) -> Value {
    json!({
        "status": "ok",
        "method": method,
        "pdfPath": pdf_path,
        "htmlPath": html_path,
        "message": format!("PDF generated at {pdf_path}"),
    })
}

/// `replace(/[^a-zA-Z0-9_-]/g, '_')`. Each UTF-16 unit of a rejected character becomes one
/// underscore, as in JavaScript.
fn sanitize_filename(raw: &str) -> String {
    let mut out = String::new();
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            out.push(character);
        } else {
            for _ in 0..character.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

/// `markdownToHtml`: headings, `- ` lists and paragraphs, one block per non-empty line.
fn markdown_to_html(markdown: &str) -> String {
    let mut output: Vec<String> = Vec::new();
    let mut list: Vec<String> = Vec::new();
    for raw_line in markdown.lines() {
        let line = js_trim(raw_line);
        if line.is_empty() {
            flush_list(&mut output, &mut list);
            continue;
        }
        if let Some(item) = line.strip_prefix("- ") {
            list.push(format!("<li>{}</li>", inline_markdown(item)));
            continue;
        }
        flush_list(&mut output, &mut list);
        if let Some(text) = line.strip_prefix("### ") {
            output.push(format!("<h3>{}</h3>", inline_markdown(text)));
        } else if let Some(text) = line.strip_prefix("## ") {
            output.push(format!("<h2>{}</h2>", inline_markdown(text)));
        } else if let Some(text) = line.strip_prefix("# ") {
            output.push(format!("<h1>{}</h1>", inline_markdown(text)));
        } else {
            output.push(format!("<p>{}</p>", inline_markdown(line)));
        }
    }
    flush_list(&mut output, &mut list);
    output.join("\n")
}

fn flush_list(output: &mut Vec<String>, list: &mut Vec<String>) {
    if list.is_empty() {
        return;
    }
    output.push("<ul>".to_string());
    output.append(list);
    output.push("</ul>".to_string());
}

/// `formatInlineMarkdown`: bold, italic and code spans. The text is not HTML-escaped, as in
/// TypeScript.
fn inline_markdown(content: &str) -> String {
    let text = STRONG.replace_all(content, "<strong>${1}</strong>");
    let text = EMPHASIS.replace_all(&text, "<em>${1}</em>");
    CODE.replace_all(&text, "<code>${1}</code>").into_owned()
}

fn wrap_in_html_page(content: &str, title: &str) -> String {
    format!(
        "<!DOCTYPE html>
<html>
<head>
<meta charset=\"UTF-8\">
<title>{title}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }}
  h1, h2, h3 {{ color: #111; }}
  code {{ background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }}
  pre {{ background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }}
  ul, ol {{ margin: 0 0 1em; }}
</style>
</head>
<body>
{content}
</body>
</html>"
    )
}

/// Finds a program by name on `PATH`, or checks an explicit path. Nothing is executed.
fn find_executable(candidate: &str) -> Option<PathBuf> {
    if candidate.contains(['/', '\\']) {
        let path = Path::new(candidate);
        return path.is_file().then(|| path.to_path_buf());
    }
    let search = std::env::var_os("PATH")?;
    let suffixes: &[&str] = if cfg!(windows) { &["", ".exe"] } else { &[""] };
    std::env::split_paths(&search)
        .flat_map(|dir| {
            suffixes
                .iter()
                .map(move |suffix| dir.join(format!("{candidate}{suffix}")))
        })
        .find(|path| path.is_file())
}

/// Runs a converter without a shell and reports whether it exited with success. A converter
/// that runs past [`CONVERTER_TIMEOUT`] is killed.
fn run_converter(program: impl AsRef<OsStr>, args: &[String]) -> bool {
    let spawned = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return false;
    };
    let deadline = Instant::now() + CONVERTER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn io_error(error: std::io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::types::test_support::TempDir;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn filenames_keep_only_safe_characters() {
        assert_eq!(sanitize_filename("my report!.pdf"), "my_report__pdf");
        assert_eq!(
            sanitize_filename("a\u{1F600}b"),
            "a__b",
            "a surrogate pair is two units"
        );
        assert_eq!(sanitize_filename("ok-name_1"), "ok-name_1");
    }

    #[test]
    fn markdown_becomes_headings_lists_and_paragraphs() {
        let html = markdown_to_html("# Title\n\n- a **b**\n- `c`\n\nText *it*");
        assert_eq!(
            html,
            "<h1>Title</h1>\n<ul>\n<li>a <strong>b</strong></li>\n<li><code>c</code></li>\n</ul>\n<p>Text <em>it</em></p>"
        );
    }

    #[test]
    fn without_a_converter_the_html_file_is_the_result() {
        let dir = TempDir::new();
        let ctx = SkillDispatchContext {
            bypass_approval: false,
            workspace_cwd: Some(dir.0.to_string_lossy().into_owned()),
        };
        let out = generate(
            &args(json!({"content": "<p>Hi</p>", "filename": "note"})),
            &ctx,
            &Converters::default(),
        )
        .expect("generated");
        assert_eq!(out["status"], "html_only");
        assert_eq!(out["method"], "none");
        let html_path = dir.0.join("output").join("note.html");
        assert_eq!(out["htmlPath"].as_str(), html_path.to_str());
        let page = fs::read_to_string(&html_path).expect("html file");
        assert!(page.contains("<p>Hi</p>"), "HTML input is used as it is");
        assert!(page.contains("<title>note</title>"));
        assert!(!page.contains("<ul>"));
    }

    #[test]
    fn missing_content_is_an_error_object() {
        let dir = TempDir::new();
        let ctx = SkillDispatchContext {
            bypass_approval: false,
            workspace_cwd: Some(dir.0.to_string_lossy().into_owned()),
        };
        let out = generate(
            &args(json!({"content": "   "})),
            &ctx,
            &Converters::default(),
        )
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "content (or html / markdown) is required" })
        );
    }

    #[test]
    fn a_missing_program_does_not_run() {
        assert!(!run_converter("betaclaw-no-such-converter-xyz", &[]));
    }
}
