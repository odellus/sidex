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
            let content = if line.is_some() || limit.is_some() {
                let lines: Vec<&str> = content.lines().collect();
                let start = line.map(|l| l.saturating_sub(1)).unwrap_or(0);
                let end = limit.map(|lim| (start + lim).min(lines.len())).unwrap_or(lines.len());
                lines[start..end].join("\n")
            } else {
                content
            };
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
