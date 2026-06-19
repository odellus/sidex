//! Filesystem tools: fs/read_text_file, fs/write_text_file

use serde_json::Value;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, ReadTextFileResponse, WriteTextFileResponse};

use super::ToolContext;

pub async fn read_text_file(params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
    let line = params.get("line").and_then(|v| v.as_u64()).map(|v| v as usize);
    let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    
    match tokio::task::spawn_blocking({
        let path = path.to_string();
        move || sidex_workspace::file_ops::read_file(std::path::Path::new(&path))
    })
    .await
    {
        Ok(Ok(content)) => {
            let content = slice_lines(&content, line, limit);
            let resp = ReadTextFileResponse::new(content);
            serde_json::to_value(ClientResponse::ReadTextFileResponse(resp))
                .map_err(|e| e.to_string())
        }
        Ok(Err(e)) => Err(format!("failed to read file: {e}")),
        Err(e) => Err(format!("task failed: {e}")),
    }
}

pub async fn write_text_file(params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");

    match tokio::task::spawn_blocking({
        let path = path.to_string();
        let content = content.to_string();
        move || sidex_workspace::file_ops::write_file(std::path::Path::new(&path), &content)
    })
    .await
    {
        Ok(Ok(())) => {
            let resp = WriteTextFileResponse::new();
            serde_json::to_value(ClientResponse::WriteTextFileResponse(resp))
                .map_err(|e| e.to_string())
        }
        Ok(Err(e)) => Err(format!("failed to write file: {e}")),
        Err(e) => Err(format!("task failed: {e}")),
    }
}

/// Extract a window of lines from `content`. `line` is 1-indexed.
///
/// Both `line` and `limit` are clamped to the available lines, so this never
/// panics on out-of-range requests (the bug that crashed the live app when an
/// agent requested a `line` past EOF).
fn slice_lines(content: &str, line: Option<usize>, limit: Option<usize>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let lines: Vec<&str> = content.lines().collect();
    let start = line
        .map(|l| l.saturating_sub(1))
        .unwrap_or(0)
        .min(lines.len());
    let end = limit
        .map(|lim| (start + lim).min(lines.len()))
        .unwrap_or(lines.len());
    lines[start..end].join("\n")
}

#[cfg(test)]
mod tests {
    use super::slice_lines;

    #[test]
    fn line_past_eof_does_not_panic() {
        // The crash case: request line 2000 of a 3-line file.
        let content = "a\nb\nc";
        let out = slice_lines(content, Some(2000), None);
        assert_eq!(out, "");
    }

    #[test]
    fn no_line_no_limit_returns_full_content() {
        let content = "a\nb\nc";
        assert_eq!(slice_lines(content, None, None), content);
    }

    #[test]
    fn line_only_from_start() {
        // `line` is the 1-indexed start; no limit → through EOF.
        assert_eq!(slice_lines("a\nb\nc", Some(2), None), "b\nc");
    }

    #[test]
    fn line_one_indexed() {
        assert_eq!(slice_lines("a\nb\nc", Some(1), None), "a\nb\nc");
    }

    #[test]
    fn line_zero_is_clamped_to_first() {
        // line=0 saturating_sub(1) = 0 → whole file, not a panic
        assert_eq!(slice_lines("a\nb\nc", Some(0), None), "a\nb\nc");
    }

    #[test]
    fn limit_only_from_top() {
        assert_eq!(slice_lines("a\nb\nc\nd", None, Some(2)), "a\nb");
    }

    #[test]
    fn line_and_limit_window() {
        assert_eq!(slice_lines("a\nb\nc\nd", Some(2), Some(2)), "b\nc");
    }

    #[test]
    fn limit_past_eof_is_clamped() {
        assert_eq!(slice_lines("a\nb", None, Some(100)), "a\nb");
    }

    #[test]
    fn empty_content() {
        assert_eq!(slice_lines("", Some(1), None), "");
    }
}
