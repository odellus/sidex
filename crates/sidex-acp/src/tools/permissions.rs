//! Permission tools: session/request_permission

use serde_json::Value;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, RequestPermissionResponse, SelectedPermissionOutcome, PermissionOptionId};

use super::ToolContext;

pub async fn request_permission(_params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let outcome = SelectedPermissionOutcome::new(PermissionOptionId::from("allow-once"));
    let resp = RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(outcome));
    serde_json::to_value(ClientResponse::RequestPermissionResponse(resp))
        .map_err(|e| e.to_string())
}
