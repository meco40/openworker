//! Reads the YAML frontmatter of a SKILL.md file.
//!
//! Port of the `yaml` package call in `src/server/skills/skillMd/parser.ts` (core schema).
//! The workspace has no YAML crate, and this change may not add one, so this module reads
//! the block subset that SKILL.md files use:
//!
//! - block mappings and block sequences, nested by indentation,
//! - plain, single-quoted and double-quoted scalars, plain ones over several lines,
//! - flow sequences and flow mappings written on one line,
//! - literal (`|`) and folded (`>`) block scalars with the clip, strip and keep marks,
//! - comments.
//!
//! Anchors, aliases, tags, multi-line flow collections, explicit indentation indicators
//! and multiple documents are refused with an error. A refused file is skipped, as an
//! invalid SKILL.md is in TypeScript, so nothing is read wrongly.
//!
//! ponytail: subset reader. Replace it with a YAML crate once one may enter the workspace.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Number, Value};

/// Parses `text` into a JSON value. Scalars resolve by the YAML 1.2 core schema.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut reader = Reader {
        lines: text.lines().map(str::to_string).collect(),
        pos: 0,
    };
    let value = reader.parse_node(0)?;
    if let Some(index) = reader.next_content(reader.pos) {
        return Err(format!("unexpected content on line {}", index + 1));
    }
    Ok(value)
}

struct Reader {
    lines: Vec<String>,
    pos: usize,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn is_blank_or_comment(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

fn is_seq_entry(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

impl Reader {
    /// Index of the first line at or after `from` that carries content.
    fn next_content(&self, from: usize) -> Option<usize> {
        (from..self.lines.len()).find(|&i| !is_blank_or_comment(&self.lines[i]))
    }

    /// Indentation of line `index`. Tabs in the indentation are refused.
    fn indent(&self, index: usize) -> Result<usize, String> {
        let line = &self.lines[index];
        if line.trim_start_matches(' ').starts_with('\t') {
            return Err(format!(
                "tabs are not allowed for indentation on line {}",
                index + 1
            ));
        }
        Ok(indent_of(line))
    }

    fn parse_node(&mut self, min_indent: usize) -> Result<Value, String> {
        let Some(index) = self.next_content(self.pos) else {
            return Ok(Value::Null);
        };
        let indent = self.indent(index)?;
        if indent < min_indent {
            return Ok(Value::Null);
        }
        self.pos = index;
        let content = self.lines[index][indent..].to_string();
        if is_seq_entry(&content) {
            return self.parse_seq(indent);
        }
        if split_key(&content)?.is_some() {
            return self.parse_map(indent);
        }
        self.pos = index + 1;
        self.parse_inline(&content, indent)
    }

    fn parse_map(&mut self, indent: usize) -> Result<Value, String> {
        let mut map = Map::new();
        while let Some(index) = self.next_content(self.pos) {
            let line_indent = self.indent(index)?;
            if line_indent < indent {
                break;
            }
            if line_indent > indent {
                return Err(format!("bad indentation on line {}", index + 1));
            }
            let content = self.lines[index][indent..].to_string();
            if is_seq_entry(&content) {
                return Err(format!(
                    "sequence item where a mapping key is expected on line {}",
                    index + 1
                ));
            }
            let Some((key, rest)) = split_key(&content)? else {
                return Err(format!(
                    "expected a 'key: value' pair on line {}",
                    index + 1
                ));
            };
            if map.contains_key(&key) {
                return Err(format!("duplicate key \"{key}\" on line {}", index + 1));
            }
            self.pos = index + 1;
            let rest = rest.trim();
            let value = if rest.is_empty() || rest.starts_with('#') {
                match self.next_content(self.pos) {
                    Some(next) => {
                        let next_indent = self.indent(next)?;
                        let next_is_seq = is_seq_entry(&self.lines[next][next_indent..]);
                        if next_indent > indent {
                            self.parse_node(indent + 1)?
                        } else if next_indent == indent && next_is_seq {
                            self.parse_seq(indent)?
                        } else {
                            Value::Null
                        }
                    }
                    None => Value::Null,
                }
            } else {
                self.parse_inline(rest, indent + 1)?
            };
            map.insert(key, value);
        }
        Ok(Value::Object(map))
    }

    fn parse_seq(&mut self, indent: usize) -> Result<Value, String> {
        let mut items = Vec::new();
        while let Some(index) = self.next_content(self.pos) {
            let line_indent = self.indent(index)?;
            if line_indent < indent {
                break;
            }
            if line_indent > indent {
                return Err(format!("bad indentation on line {}", index + 1));
            }
            let content = self.lines[index][indent..].to_string();
            if !is_seq_entry(&content) {
                break;
            }
            let rest = content[1..].trim_start_matches(' ');
            if rest.is_empty() || rest.starts_with('#') {
                self.pos = index + 1;
                let body_follows = match self.next_content(self.pos) {
                    Some(next) => self.indent(next)? > indent,
                    None => false,
                };
                let item = if body_follows {
                    self.parse_node(indent + 1)?
                } else {
                    Value::Null
                };
                items.push(item);
            } else {
                // The item body starts in the same line. Rewrite that line so the body reads
                // as a node at its own column, which the map and sequence readers handle.
                let column = indent + content.len() - rest.len();
                self.lines[index] = format!("{}{}", " ".repeat(column), rest);
                self.pos = index;
                items.push(self.parse_node(column)?);
            }
        }
        Ok(Value::Array(items))
    }

    /// A value that starts on the key line or the dash line. `cont_min` is the smallest
    /// indentation that a continuation line may have.
    fn parse_inline(&mut self, text: &str, cont_min: usize) -> Result<Value, String> {
        let trimmed = text.trim();
        match trimmed.chars().next() {
            Some('|') | Some('>') => self.block_scalar(trimmed, cont_min),
            Some('[') | Some('{') => {
                let chars: Vec<char> = trimmed.chars().collect();
                let mut flow = Flow {
                    chars: &chars,
                    at: 0,
                };
                let value = flow.value()?;
                rest_is_clean(&chars[flow.at..])?;
                Ok(value)
            }
            Some('"') | Some('\'') => {
                let chars: Vec<char> = trimmed.chars().collect();
                let (text, end) = parse_quoted(&chars, 0)?;
                rest_is_clean(&chars[end..])?;
                Ok(Value::String(text))
            }
            Some('&') | Some('*') | Some('!') => {
                Err("anchors, aliases and tags are not supported".to_string())
            }
            _ => {
                let mut plain = strip_comment(trimmed).to_string();
                while self.pos < self.lines.len() {
                    let line = self.lines[self.pos].clone();
                    if is_blank_or_comment(&line) || indent_of(&line) < cont_min {
                        break;
                    }
                    self.indent(self.pos)?;
                    let content = line.trim();
                    if is_seq_entry(content) || content.contains(": ") || content.ends_with(':') {
                        return Err(format!(
                            "ambiguous multi-line plain scalar on line {}",
                            self.pos + 1
                        ));
                    }
                    plain.push(' ');
                    plain.push_str(strip_comment(content));
                    self.pos += 1;
                }
                Ok(resolve_plain(&plain))
            }
        }
    }

    /// `|` and `>` block scalars. `self.pos` is the line after the header.
    fn block_scalar(&mut self, header: &str, cont_min: usize) -> Result<Value, String> {
        let literal = header.starts_with('|');
        let indicators = header[1..].split('#').next().unwrap_or("").trim();
        let mut chomp = Chomp::Clip;
        for ch in indicators.chars() {
            match ch {
                '-' => chomp = Chomp::Strip,
                '+' => chomp = Chomp::Keep,
                '1'..='9' => {
                    return Err("explicit indentation indicators are not supported".to_string())
                }
                _ => return Err(format!("invalid block scalar header \"{header}\"")),
            }
        }

        let mut body: Vec<String> = Vec::new();
        let mut block_indent: Option<usize> = None;
        while self.pos < self.lines.len() {
            let line = self.lines[self.pos].clone();
            if line.trim().is_empty() {
                body.push(String::new());
                self.pos += 1;
                continue;
            }
            let line_indent = self.indent(self.pos)?;
            if line_indent < cont_min {
                break;
            }
            let block = *block_indent.get_or_insert(line_indent);
            if line_indent < block {
                break;
            }
            body.push(line[block..].to_string());
            self.pos += 1;
        }

        let trailing = body.iter().rev().take_while(|line| line.is_empty()).count();
        body.truncate(body.len() - trailing);
        if body.is_empty() {
            let text = if chomp == Chomp::Keep {
                "\n".repeat(trailing)
            } else {
                String::new()
            };
            return Ok(Value::String(text));
        }
        let text = if literal {
            body.join("\n")
        } else {
            fold_lines(&body)
        };
        Ok(Value::String(match chomp {
            Chomp::Strip => text,
            Chomp::Clip => text + "\n",
            Chomp::Keep => text + &"\n".repeat(trailing + 1),
        }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chomp {
    Clip,
    Strip,
    Keep,
}

/// Folded block scalar: a line break between two text lines becomes a space, and an empty
/// line becomes a line break.
fn fold_lines(lines: &[String]) -> String {
    let mut out = String::new();
    let mut previous_text = false;
    for line in lines {
        if line.is_empty() {
            out.push('\n');
            previous_text = false;
        } else {
            if previous_text {
                out.push(' ');
            }
            out.push_str(line);
            previous_text = true;
        }
    }
    out
}

/// Splits `key: rest` for a mapping entry. Returns `None` when the line is not one.
fn split_key(content: &str) -> Result<Option<(String, String)>, String> {
    let chars: Vec<char> = content.chars().collect();
    match chars.first() {
        None | Some('[') | Some('{') | Some('#') => Ok(None),
        Some('"') | Some('\'') => {
            let (key, end) = parse_quoted(&chars, 0)?;
            let mut at = end;
            while chars.get(at) == Some(&' ') {
                at += 1;
            }
            if chars.get(at) != Some(&':') {
                return Ok(None);
            }
            at += 1;
            if matches!(chars.get(at), None | Some(' ')) {
                Ok(Some((key, chars[at..].iter().collect())))
            } else {
                Ok(None)
            }
        }
        Some(_) => {
            for (at, &ch) in chars.iter().enumerate() {
                if ch == ':' && matches!(chars.get(at + 1), None | Some(' ')) {
                    let key: String = chars[..at]
                        .iter()
                        .collect::<String>()
                        .trim_end()
                        .to_string();
                    if key.is_empty() {
                        return Ok(None);
                    }
                    return Ok(Some((key, chars[at + 1..].iter().collect())));
                }
            }
            Ok(None)
        }
    }
}

/// Reads a quoted scalar that starts at `chars[start]`. Returns the text and the index
/// after the closing quote. Quoted scalars must end on the same line.
fn parse_quoted(chars: &[char], start: usize) -> Result<(String, usize), String> {
    let quote = chars[start];
    let mut at = start + 1;
    let mut out = String::new();
    loop {
        let Some(&ch) = chars.get(at) else {
            return Err(
                "unterminated quoted scalar (multi-line quoted scalars are not supported)"
                    .to_string(),
            );
        };
        if quote == '\'' {
            if ch == '\'' {
                if chars.get(at + 1) == Some(&'\'') {
                    out.push('\'');
                    at += 2;
                    continue;
                }
                return Ok((out, at + 1));
            }
            out.push(ch);
            at += 1;
        } else {
            match ch {
                '"' => return Ok((out, at + 1)),
                '\\' => {
                    let Some(&escape) = chars.get(at + 1) else {
                        return Err("unterminated escape in quoted scalar".to_string());
                    };
                    at += 2;
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        ' ' => out.push(' '),
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        '0' => out.push('\0'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'u' => {
                            let Some(hex) = chars.get(at..at + 4) else {
                                return Err("short \\u escape".to_string());
                            };
                            let hex: String = hex.iter().collect();
                            let code = u32::from_str_radix(&hex, 16)
                                .ok()
                                .and_then(char::from_u32)
                                .ok_or_else(|| format!("invalid \\u escape \"{hex}\""))?;
                            out.push(code);
                            at += 4;
                        }
                        other => return Err(format!("unsupported escape \\{other}")),
                    }
                }
                _ => {
                    out.push(ch);
                    at += 1;
                }
            }
        }
    }
}

fn rest_is_clean(rest: &[char]) -> Result<(), String> {
    let text: String = rest.iter().collect();
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        Ok(())
    } else {
        Err(format!("unexpected text after value: \"{trimmed}\""))
    }
}

/// Drops a trailing ` # comment` from a plain scalar.
fn strip_comment(text: &str) -> &str {
    for (index, ch) in text.char_indices() {
        if ch == '#' && (index == 0 || text[..index].ends_with([' ', '\t'])) {
            return text[..index].trim_end();
        }
    }
    text
}

fn int_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[-+]?[0-9]+$").expect("valid regex"))
}

fn float_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$").expect("valid regex")
    })
}

/// Core-schema resolution of a plain scalar.
fn resolve_plain(text: &str) -> Value {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if int_pattern().is_match(text) {
        if let Ok(number) = text.trim_start_matches('+').parse::<i64>() {
            return Value::from(number);
        }
    }
    if float_pattern().is_match(text) {
        if let Some(number) = text.parse::<f64>().ok().and_then(Number::from_f64) {
            return Value::Number(number);
        }
    }
    Value::String(text.to_string())
}

/// Reads a flow collection or a flow scalar from `chars`, advancing `at`.
struct Flow<'a> {
    chars: &'a [char],
    at: usize,
}

impl Flow<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn read_plain(&mut self, stops: &[char]) -> String {
        let start = self.at;
        while let Some(ch) = self.peek() {
            if stops.contains(&ch) {
                break;
            }
            self.at += 1;
        }
        self.chars[start..self.at]
            .iter()
            .collect::<String>()
            .trim()
            .to_string()
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_spaces();
        match self.peek() {
            Some('[') => {
                self.at += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_spaces();
                    if self.eat(']') {
                        break;
                    }
                    items.push(self.value()?);
                    self.skip_spaces();
                    if self.eat(',') {
                        continue;
                    }
                    if self.eat(']') {
                        break;
                    }
                    return Err(unterminated_flow());
                }
                Ok(Value::Array(items))
            }
            Some('{') => {
                self.at += 1;
                let mut map = Map::new();
                loop {
                    self.skip_spaces();
                    if self.eat('}') {
                        break;
                    }
                    let key = match self.peek() {
                        Some('"') | Some('\'') => {
                            let (text, end) = parse_quoted(self.chars, self.at)
                                .map_err(|_| unterminated_flow())?;
                            self.at = end;
                            text
                        }
                        _ => self.read_plain(&[':', ',', '}']),
                    };
                    self.skip_spaces();
                    let value = if self.eat(':') {
                        self.skip_spaces();
                        if matches!(self.peek(), Some(',') | Some('}')) {
                            Value::Null
                        } else {
                            self.value()?
                        }
                    } else {
                        Value::Null
                    };
                    map.insert(key, value);
                    self.skip_spaces();
                    if self.eat(',') {
                        continue;
                    }
                    if self.eat('}') {
                        break;
                    }
                    return Err(unterminated_flow());
                }
                Ok(Value::Object(map))
            }
            Some('"') | Some('\'') => {
                let (text, end) =
                    parse_quoted(self.chars, self.at).map_err(|_| unterminated_flow())?;
                self.at = end;
                Ok(Value::String(text))
            }
            _ => Ok(resolve_plain(&self.read_plain(&[',', ']', '}']))),
        }
    }
}

fn unterminated_flow() -> String {
    "unterminated flow collection (multi-line flow collections are not supported)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_nested_maps_and_sequences() {
        let text = "id: shell-access\nemoji: 🐚\nos:\n  - darwin\n  - win32\nrequires:\n  env:\n    - HOME\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({
                "id": "shell-access",
                "emoji": "🐚",
                "os": ["darwin", "win32"],
                "requires": { "env": ["HOME"] }
            })
        );
    }

    #[test]
    fn reads_sequence_items_that_are_maps() {
        let text = "tool:\n  parameters:\n    required:\n      - url\n  items:\n    - name: a\n      type: string\n    - name: b\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({
                "tool": {
                    "parameters": { "required": ["url"] },
                    "items": [{ "name": "a", "type": "string" }, { "name": "b" }]
                }
            })
        );
    }

    #[test]
    fn resolves_core_schema_scalars_and_flow_collections() {
        let text = "a: 1\nb: 2.5\nc: true\nd: null\ne: text # comment\nf: [x, 2, \"y z\"]\ng: {k: v, n: 3}\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({
                "a": 1, "b": 2.5, "c": true, "d": null, "e": "text",
                "f": ["x", 2, "y z"], "g": { "k": "v", "n": 3 }
            })
        );
    }

    #[test]
    fn quoted_scalars_keep_their_text() {
        let text = "a: 'it''s'\nb: \"tab\\there\"\nc: \"# not a comment\"\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({ "a": "it's", "b": "tab\there", "c": "# not a comment" })
        );
    }

    #[test]
    fn block_scalars_follow_their_chomping_marks() {
        let text = "lit: |\n  one\n  two\nfold: >\n  one\n  two\n\n  three\nstrip: |-\n  x\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({ "lit": "one\ntwo\n", "fold": "one two\nthree\n", "strip": "x" })
        );
    }

    #[test]
    fn plain_scalars_fold_over_continuation_lines() {
        let text = "description: first part\n  second part\nnext: 1\n";
        assert_eq!(
            parse(text).expect("parses"),
            json!({ "description": "first part second part", "next": 1 })
        );
    }

    #[test]
    fn refuses_what_it_cannot_read_faithfully() {
        assert!(parse("a: &anchor 1\n").is_err(), "anchors");
        assert!(parse("a: 1\na: 2\n").is_err(), "duplicate keys");
        assert!(parse("a: [1,\n  2]\n").is_err(), "multi-line flow");
        assert!(parse("a:\n\tb: 1\n").is_err(), "tab indentation");
        assert!(parse("a: 1\n  b: 2\n").is_err(), "bad indentation");
    }

    #[test]
    fn an_empty_document_is_null() {
        assert_eq!(parse("").expect("parses"), Value::Null);
    }
}
