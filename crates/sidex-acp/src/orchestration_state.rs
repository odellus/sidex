//! Pure orchestration state machine — no I/O, fully unit-testable.
//!
//! This is the decision core of the task loop. It owns the task list,
//! current task pointer, and the caller session ID (for completion
//! callbacks). The `determine_next_prompt` method is the single entry
//! point: given the current state, it decides what (if anything) to
//! prompt the agent with next.
//!
//! ## Bipartite design (v3)
//!
//! No delegation state machine. The agent works its own task list. When
//! it finishes a react turn with incomplete tasks, it gets nagged. It
//! cannot "delegate its way out" — it must mark tasks done via
//! `task_write`. When all tasks are complete (or the list is empty),
//! the loop exits and the completion callback fires (if a caller was
//! registered via `task_send`).

use serde_json::{json, Value};

use crate::session::{Task, TaskStatus};

/// Pure orchestration state — the testable core of the task loop.
#[derive(Debug)]
pub struct OrchestrationState {
    /// The plan / TODO — single source of truth for task status.
    pub task_list: Vec<Task>,
    /// The task currently being worked on (promoted from task_list).
    pub current_task: Option<Task>,
    /// Who sent this task list (set by `task_send`). When the loop exits
    /// normally, a canned "done" notification is sent to this session.
    pub caller_session_id: Option<String>,
    /// Guard against the infinite "all done, summarize" loop.
    /// Set true after the summary prompt is emitted; prevents re-emission.
    pub summarized: bool,
}

impl Default for OrchestrationState {
    fn default() -> Self {
        Self {
            task_list: Vec::new(),
            current_task: None,
            caller_session_id: None,
            summarized: false,
        }
    }
}

impl OrchestrationState {
    // ─── State machine entry point ───────────────────────────────────────

    /// Decide what to prompt the agent with next.
    ///
    /// Returns `Some(blocks)` to send a `session/prompt`, or `None` to
    /// stop the loop (all work is done, or the list is empty). When the
    /// loop stops, the completion callback fires if a caller was registered.
    pub fn determine_next_prompt(&mut self) -> Option<Vec<Value>> {
        self.sync_current_task_status();

        // If current task is done, advance and try to start the next.
        if self.is_current_task_done() {
            self.advance_current_task();
            return self.start_next_task();
        }

        // Current task exists but isn't done — nag with incomplete tasks.
        if self.current_task.is_some() {
            return Some(self.nag_incomplete());
        }

        // No current task — try to start the next one.
        self.start_next_task()
    }

    // ─── Transitions (called by tool handlers) ───────────────────────────

    /// Called by `task_send` to record who sent this task list.
    /// When the loop exits normally, a "done" notification is sent to
    /// this session so it can `query_memory` for the final summary.
    pub fn set_caller(&mut self, session_id: String) {
        self.caller_session_id = Some(session_id);
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    /// Sync `current_task.status` with any updates made via `task_write`.
    fn sync_current_task_status(&mut self) {
        if let Some(ref mut current) = self.current_task {
            match self.task_list.iter().find(|t| t.id == current.id) {
                Some(updated) if updated.status != current.status => {
                    current.status = updated.status.clone();
                }
                None => {
                    // Task was deleted from task_list via task_write delete.
                    // Treat as done so the loop advances instead of nagging
                    // about a task that no longer exists.
                    current.status = TaskStatus::Completed;
                }
                _ => {}
            }
        }
    }

    /// True if there is a current task and it is Completed or Failed.
    fn is_current_task_done(&self) -> bool {
        matches!(
            self.current_task.as_ref(),
            Some(t) if t.status == TaskStatus::Completed || t.status == TaskStatus::Failed
        )
    }

    /// Clear the current task.
    fn advance_current_task(&mut self) {
        self.current_task = None;
    }

    /// Promote the first `Pending` task in `task_list` to `current_task`.
    /// Returns the prompt blocks for that task, or a summary prompt if all
    /// tasks are done, or `None` if there's nothing to do.
    fn start_next_task(&mut self) -> Option<Vec<Value>> {
        // Find and promote the first Pending task.
        if let Some(task) = self.task_list.iter_mut().find(|t| t.status == TaskStatus::Pending) {
            task.status = TaskStatus::InProgress;
            task.updated_at = chrono::Utc::now();
            let promoted = task.clone();
            self.current_task = Some(promoted.clone());
            return Some(Self::task_prompt(&promoted));
        }

        // No pending tasks. If all are completed/failed and we haven't
        // summarized yet, emit the summary prompt once.
        let all_done = !self.task_list.is_empty()
            && self.task_list.iter().all(|t| {
                t.status == TaskStatus::Completed || t.status == TaskStatus::Failed
            });

        if all_done && !self.summarized {
            self.summarized = true;
            return Some(Self::summary_prompt());
        }

        None
    }

    // ─── Prompt builders ─────────────────────────────────────────────────

    fn task_prompt(task: &Task) -> Vec<Value> {
        vec![json!({
            "type": "text",
            "text": format!(
                "Current task: {}\n\n{}\n\n\
                 Work on this task. When it is complete, mark it done with the \
                 task_write tool (action=\"update\", status=\"completed\", \
                 taskId=\"{}\").",
                task.title,
                task.description.as_deref().unwrap_or(""),
                task.id,
            )
        })]
    }

    fn nag_incomplete(&self) -> Vec<Value> {
        let incomplete: Vec<&Task> = self.task_list.iter()
            .filter(|t| t.status == TaskStatus::Pending || t.status == TaskStatus::InProgress)
            .collect();

        let task_lines: Vec<String> = incomplete.iter()
            .map(|t| {
                let status = match t.status {
                    TaskStatus::InProgress => "in_progress",
                    TaskStatus::Pending => "pending",
                    _ => "unknown",
                };
                format!("- [{}] {} (id: {})", status, t.title, t.id)
            })
            .collect();

        vec![json!({
            "type": "text",
            "text": format!(
                "You have {} incomplete task(s):\n\n{}\n\n\
                 Mark completed tasks done with task_write (action=\"update\", \
                 status=\"completed\", taskId=\"<id>\") or continue working on them.",
                incomplete.len(),
                task_lines.join("\n"),
            )
        })]
    }

    fn summary_prompt() -> Vec<Value> {
        vec![json!({
            "type": "text",
            "text": "All tasks are complete. Call no tools and summarize what you accomplished."
        })]
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(id: &str, title: &str) -> Task {
        Task {
            id: id.to_string(),
            title: title.to_string(),
            description: None,
            status: TaskStatus::Pending,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn in_progress(id: &str, title: &str) -> Task {
        let mut t = pending(id, title);
        t.status = TaskStatus::InProgress;
        t
    }

    fn completed(id: &str, title: &str) -> Task {
        let mut t = pending(id, title);
        t.status = TaskStatus::Completed;
        t
    }

    fn failed(id: &str, title: &str) -> Task {
        let mut t = pending(id, title);
        t.status = TaskStatus::Failed;
        t
    }

    fn text_of(blocks: &[Value]) -> &str {
        blocks
            .first()
            .and_then(|b| b.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
    }

    // ── Empty / stop conditions ───────────────────────────────────────────

    #[test]
    fn empty_list_stops() {
        let mut s = OrchestrationState::default();
        assert_eq!(s.determine_next_prompt(), None);
    }

    #[test]
    fn all_done_summary_emitted_once_then_stops() {
        let mut s = OrchestrationState {
            task_list: vec![completed("t1", "first"), completed("t2", "second")],
            ..Default::default()
        };

        // First: summary
        let blocks = s.determine_next_prompt().expect("should summarize");
        assert!(text_of(&blocks).contains("All tasks are complete"));
        assert!(s.summarized);

        // Second: stop (not infinite)
        assert_eq!(s.determine_next_prompt(), None);
    }

    #[test]
    fn failed_tasks_count_as_done_for_summary() {
        let mut s = OrchestrationState {
            task_list: vec![failed("t1", "first"), completed("t2", "second")],
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should summarize");
        assert!(text_of(&blocks).contains("All tasks are complete"));
    }

    // ── Task promotion ────────────────────────────────────────────────────

    #[test]
    fn pending_tasks_starts_first() {
        let mut s = OrchestrationState {
            task_list: vec![pending("t1", "first"), pending("t2", "second")],
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start t1");
        assert!(text_of(&blocks).contains("first"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t1");
        assert_eq!(s.current_task.unwrap().status, TaskStatus::InProgress);
    }

    #[test]
    fn start_next_task_promotes_first_pending_only() {
        let mut s = OrchestrationState {
            task_list: vec![
                completed("t1", "first"),
                in_progress("t2", "second"), // shouldn't be re-promoted
                pending("t3", "third"),
            ],
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start t3");
        assert!(text_of(&blocks).contains("third"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t3");
    }

    #[test]
    fn mixed_pending_and_completed_does_not_summarize() {
        let mut s = OrchestrationState {
            task_list: vec![completed("t1", "first"), pending("t2", "second")],
            ..Default::default()
        };

        // Should start the pending task, not summarize
        let blocks = s.determine_next_prompt().expect("should start pending task");
        assert!(text_of(&blocks).contains("second"));
        assert!(!s.summarized);
    }

    // ── Nag on incomplete ─────────────────────────────────────────────────

    #[test]
    fn current_task_incomplete_nags() {
        let mut s = OrchestrationState {
            task_list: vec![in_progress("t1", "first")],
            current_task: Some(in_progress("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should nag");
        let text = text_of(&blocks);
        assert!(text.contains("incomplete task"));
        assert!(text.contains("first"));
        assert!(text.contains("t1"));
        assert!(text.contains("task_write"));
    }

    #[test]
    fn nag_lists_all_incomplete_tasks() {
        let mut s = OrchestrationState {
            task_list: vec![
                in_progress("t1", "first"),
                pending("t2", "second"),
                completed("t3", "third"),
            ],
            current_task: Some(in_progress("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should nag");
        let text = text_of(&blocks);
        assert!(text.contains("first"));
        assert!(text.contains("second"));
        // Completed task should NOT appear in the nag
        assert!(!text.contains("third"));
        assert!(text.contains("2 incomplete task"));
    }

    // ── Advance / done → next ─────────────────────────────────────────────

    #[test]
    fn current_task_done_advances_and_starts_next() {
        let mut s = OrchestrationState {
            task_list: vec![
                completed("t1", "first"),
                pending("t2", "second"),
            ],
            current_task: Some(completed("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start next");
        assert!(text_of(&blocks).contains("second"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t2");
    }

    #[test]
    fn current_task_done_no_more_tasks_sends_summary_once() {
        let mut s = OrchestrationState {
            task_list: vec![completed("t1", "first")],
            current_task: Some(completed("t1", "first")),
            ..Default::default()
        };

        // First call: advance (current done) → start_next_task → all done → summary
        let blocks = s.determine_next_prompt().expect("should send summary");
        assert!(text_of(&blocks).contains("All tasks are complete"));
        assert!(s.summarized);

        // Second call: summarized flag is set → should stop
        assert_eq!(s.determine_next_prompt(), None);
    }

    // ── sync_current_task_status ──────────────────────────────────────────

    #[test]
    fn sync_picks_up_task_write_status_change() {
        let mut s = OrchestrationState {
            task_list: vec![completed("t1", "first")], // task_write updated it
            current_task: Some(in_progress("t1", "first")), // stale
            ..Default::default()
        };

        // sync should detect t1 is now completed → advance → summary (all done)
        let blocks = s.determine_next_prompt().expect("should advance and summarize");
        assert!(text_of(&blocks).contains("All tasks are complete"));
        assert!(s.current_task.is_none());
    }

    #[test]
    fn sync_treats_deleted_current_task_as_done() {
        let mut s = OrchestrationState {
            task_list: vec![pending("t2", "second")], // t1 was deleted
            current_task: Some(in_progress("t1", "first")), // stale
            ..Default::default()
        };

        // sync should detect t1 is gone → treat as Completed → advance → start t2
        let blocks = s.determine_next_prompt().expect("should advance to t2");
        assert!(text_of(&blocks).contains("second"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t2");
    }

    // ── Caller tracking ───────────────────────────────────────────────────

    #[test]
    fn set_caller_stores_session_id() {
        let mut s = OrchestrationState::default();
        assert!(s.caller_session_id.is_none());
        s.set_caller("orchestrator-sid".to_string());
        assert_eq!(s.caller_session_id.as_deref(), Some("orchestrator-sid"));
    }

    #[test]
    fn set_caller_overwrites_previous() {
        let mut s = OrchestrationState {
            caller_session_id: Some("old-caller".to_string()),
            ..Default::default()
        };
        s.set_caller("new-caller".to_string());
        assert_eq!(s.caller_session_id.as_deref(), Some("new-caller"));
    }

    // ── Correct tool names in prompts ─────────────────────────────────────

    #[test]
    fn task_prompt_mentions_correct_tools() {
        let task = pending("t1", "do thing");
        let blocks = OrchestrationState::task_prompt(&task);
        let text = text_of(&blocks);
        assert!(text.contains("task_write"));
        assert!(text.contains("completed"));
        assert!(text.contains("t1"));
        // Should NOT reference delegation
        assert!(!text.contains("delegate"));
        assert!(!text.contains("send_prompt"));
    }

    #[test]
    fn nag_incomplete_mentions_correct_tools() {
        let s = OrchestrationState {
            task_list: vec![in_progress("t1", "first")],
            current_task: Some(in_progress("t1", "first")),
            ..Default::default()
        };
        let blocks = s.nag_incomplete();
        let text = text_of(&blocks);
        assert!(text.contains("task_write"));
        assert!(text.contains("completed"));
        // Should NOT reference delegation
        assert!(!text.contains("delegate"));
        assert!(!text.contains("send_prompt"));
    }

    // ── Full loop simulation ──────────────────────────────────────────────

    #[test]
    fn full_loop_two_tasks_then_summary_then_stop() {
        let mut s = OrchestrationState {
            task_list: vec![pending("t1", "first"), pending("t2", "second")],
            ..Default::default()
        };

        // Turn 1: start t1
        let b = s.determine_next_prompt().expect("start t1");
        assert!(text_of(&b).contains("first"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t1");

        // Agent ends turn without marking done → nag
        let b = s.determine_next_prompt().expect("nag t1");
        assert!(text_of(&b).contains("incomplete task"));
        assert!(text_of(&b).contains("first"));

        // Agent marks t1 done via task_write (updates task_list)
        s.task_list[0].status = TaskStatus::Completed;

        // Next loop: sync detects done → advance → start t2
        let b = s.determine_next_prompt().expect("start t2");
        assert!(text_of(&b).contains("second"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t2");

        // Agent marks t2 done
        s.task_list[1].status = TaskStatus::Completed;

        // Next loop: advance → all done → summary
        let b = s.determine_next_prompt().expect("summary");
        assert!(text_of(&b).contains("All tasks are complete"));

        // Loop stops
        assert_eq!(s.determine_next_prompt(), None);
    }
}
