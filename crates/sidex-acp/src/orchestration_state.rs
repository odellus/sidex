//! Pure orchestration state machine — no I/O, fully unit-testable.
//!
//! This is the decision core of the Ralph loop. It owns the task list,
//! current task pointer, delegation state, and worker summary. The
//! `determine_next_prompt` method is the single entry point: given the
//! current state, it decides what (if anything) to prompt the agent with
//! next.
//!
//! `AcpSession` holds this behind a single `Mutex`, which eliminates the
//! lock-ordering risk of the old 4-mutex design and the sync drift between
//! `task_list` and `task_queue`.

use serde_json::{json, Value};

use crate::session::{DelegationState, Task, TaskStatus};

/// Pure orchestration state — the testable core of the Ralph loop.
#[derive(Debug)]
pub struct OrchestrationState {
    /// The plan / TODO — single source of truth for task status.
    pub task_list: Vec<Task>,
    /// The task currently being worked on (promoted from task_list).
    pub current_task: Option<Task>,
    /// Delegation state machine.
    pub delegation_state: DelegationState,
    /// Worker summary stashed by the `_send` callback; consumed by the
    /// `Responding` nag so the agent sees what the worker did.
    pub delegation_summary: Option<String>,
    /// Guard against the infinite "all done, summarize" loop.
    /// Set true after the summary prompt is emitted; prevents re-emission.
    pub summarized: bool,
}

impl Default for OrchestrationState {
    fn default() -> Self {
        Self {
            task_list: Vec::new(),
            current_task: None,
            delegation_state: DelegationState::NotCalled,
            delegation_summary: None,
            summarized: false,
        }
    }
}

impl OrchestrationState {
    // ─── State machine entry point ───────────────────────────────────────

    /// Decide what to prompt the agent with next.
    ///
    /// Returns `Some(blocks)` to send a `session/prompt`, or `None` to
    /// stop the loop (waiting for an async callback, or all work is done).
    pub fn determine_next_prompt(&mut self) -> Option<Vec<Value>> {
        self.sync_current_task_status();

        match self.delegation_state {
            DelegationState::WaitingForResponse => {
                // Delegated — do nothing until the _send callback arrives.
                None
            }

            DelegationState::Responding => {
                if self.is_current_task_done() {
                    self.advance_current_task();
                    self.start_next_task()
                } else {
                    let summary = self.delegation_summary.take().unwrap_or_else(|| {
                        "(no summary was provided by the worker)".to_string()
                    });
                    Some(Self::nag_evaluate(&summary))
                }
            }

            DelegationState::NotCalled => {
                if self.is_current_task_done() {
                    self.advance_current_task();
                    self.start_next_task()
                } else if self.current_task.is_some() {
                    Some(Self::nag_delegate())
                } else {
                    self.start_next_task()
                }
            }
        }
    }

    // ─── Transitions (called by tool handlers / callbacks) ───────────────

    /// Called by `_send` tool handler when the agent delegates to a worker.
    pub fn set_waiting_for_response(&mut self) {
        self.delegation_state = DelegationState::WaitingForResponse;
        self.delegation_summary = None;
    }

    /// Called by the `_send` callback when the worker's summary arrives.
    pub fn set_responding(&mut self, summary: String) {
        self.delegation_state = DelegationState::Responding;
        self.delegation_summary = Some(summary);
    }

    /// Called when a new prompt arrives from the user or task queue.
    /// Resets delegation state to NotCalled (a new turn has begun).
    pub fn reset_delegation(&mut self) {
        self.delegation_state = DelegationState::NotCalled;
        self.delegation_summary = None;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    /// Sync `current_task.status` with any updates made via `task_write`.
    fn sync_current_task_status(&mut self) {
        if let Some(ref mut current) = self.current_task {
            if let Some(updated) = self.task_list.iter().find(|t| t.id == current.id) {
                if updated.status != current.status {
                    current.status = updated.status.clone();
                }
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

    /// Clear the current task and reset delegation state.
    fn advance_current_task(&mut self) {
        self.current_task = None;
        self.delegation_state = DelegationState::NotCalled;
        self.delegation_summary = None;
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
            self.delegation_state = DelegationState::NotCalled;
            self.delegation_summary = None;
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
                 Delegate this to a worker session using the send_prompt tool \
                 (with to_session_id and blocks). \
                 When the work is complete, mark it done with the task_write tool \
                 (action=\"update\", status=\"completed\", task_id=\"{}\").",
                task.title,
                task.description.as_deref().unwrap_or(""),
                task.id,
            )
        })]
    }

    fn nag_delegate() -> Vec<Value> {
        vec![json!({
            "type": "text",
            "text": "You have an active task but did not delegate it. \
                     Use the send_prompt tool to delegate it to a worker session, \
                     or use the task_write tool (action=\"update\", status=\"completed\") \
                     to mark it done if the work is already finished."
        })]
    }

    fn nag_evaluate(summary: &str) -> Vec<Value> {
        vec![json!({
            "type": "text",
            "text": format!(
                "You received a response from the delegated worker:\n\n\
                 {}\n\n\
                 Review it and mark the task done with the task_write tool \
                 (action=\"update\", status=\"completed\") if acceptable, \
                 or send it back to the worker with the send_prompt tool if it needs more work.",
                summary
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

    // ── WaitingForResponse ────────────────────────────────────────────────

    #[test]
    fn waiting_for_response_stops_loop() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::WaitingForResponse,
            task_list: vec![pending("t1", "do thing")],
            current_task: Some(in_progress("t1", "do thing")),
            ..Default::default()
        };
        assert_eq!(s.determine_next_prompt(), None);
    }

    // ── Responding ────────────────────────────────────────────────────────

    #[test]
    fn responding_task_done_advances_and_starts_next() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::Responding,
            task_list: vec![
                completed("t1", "first"),
                pending("t2", "second"),
            ],
            current_task: Some(completed("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start next task");
        assert!(text_of(&blocks).contains("second"));
        assert_eq!(s.delegation_state, DelegationState::NotCalled);
        assert!(s.current_task.as_ref().unwrap().id == "t2");
        assert_eq!(s.current_task.unwrap().status, TaskStatus::InProgress);
    }

    #[test]
    fn responding_task_not_done_nags_with_summary() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::Responding,
            task_list: vec![in_progress("t1", "first")],
            current_task: Some(in_progress("t1", "first")),
            delegation_summary: Some("I refactored the auth module".to_string()),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should nag");
        let text = text_of(&blocks);
        assert!(text.contains("I refactored the auth module"));
        assert!(text.contains("task_write"));
        assert!(text.contains("send_prompt"));
        // Summary should be consumed after nagging
        assert!(s.delegation_summary.is_none());
    }

    #[test]
    fn responding_no_current_task_nags_anyway() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::Responding,
            task_list: vec![pending("t1", "first")],
            current_task: None,
            delegation_summary: Some("done".to_string()),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should nag");
        assert!(text_of(&blocks).contains("done"));
    }

    #[test]
    fn responding_task_done_no_more_tasks_sends_summary_once() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::Responding,
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

    // ── NotCalled ─────────────────────────────────────────────────────────

    #[test]
    fn not_called_task_done_advances_and_starts_next() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::NotCalled,
            task_list: vec![
                completed("t1", "first"),
                pending("t2", "second"),
            ],
            current_task: Some(completed("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start next");
        assert!(text_of(&blocks).contains("second"));
        assert!(s.current_task.as_ref().unwrap().id == "t2");
    }

    #[test]
    fn not_called_task_not_done_nags_delegate() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::NotCalled,
            task_list: vec![in_progress("t1", "first")],
            current_task: Some(in_progress("t1", "first")),
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should nag");
        let text = text_of(&blocks);
        assert!(text.contains("send_prompt"));
        assert!(text.contains("task_write"));
    }

    #[test]
    fn not_called_no_current_task_starts_next() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::NotCalled,
            task_list: vec![pending("t1", "first")],
            current_task: None,
            ..Default::default()
        };

        let blocks = s.determine_next_prompt().expect("should start task");
        assert!(text_of(&blocks).contains("first"));
        assert!(s.current_task.as_ref().unwrap().id == "t1");
        assert_eq!(s.current_task.unwrap().status, TaskStatus::InProgress);
    }

    #[test]
    fn not_called_empty_list_stops() {
        let mut s = OrchestrationState::default();
        assert_eq!(s.determine_next_prompt(), None);
    }

    // ── Summary / infinite-loop guard ─────────────────────────────────────

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

    // ── start_next_task promotion logic ───────────────────────────────────

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
        assert!(s.current_task.as_ref().unwrap().id == "t3");
    }

    // ── sync_current_task_status ──────────────────────────────────────────

    #[test]
    fn sync_picks_up_task_write_status_change() {
        let mut s = OrchestrationState {
            task_list: vec![completed("t1", "first")], // task_write updated it
            current_task: Some(in_progress("t1", "first")), // stale
            delegation_state: DelegationState::NotCalled,
            ..Default::default()
        };

        // sync should detect t1 is now completed → advance → summary (all done)
        let blocks = s.determine_next_prompt().expect("should advance and summarize");
        assert!(text_of(&blocks).contains("All tasks are complete"));
        assert!(s.current_task.is_none());
    }

    // ── Transition methods ────────────────────────────────────────────────

    #[test]
    fn set_waiting_for_response_clears_summary() {
        let mut s = OrchestrationState {
            delegation_summary: Some("old".to_string()),
            ..Default::default()
        };
        s.set_waiting_for_response();
        assert_eq!(s.delegation_state, DelegationState::WaitingForResponse);
        assert!(s.delegation_summary.is_none());
    }

    #[test]
    fn set_responding_stashes_summary() {
        let mut s = OrchestrationState::default();
        s.set_responding("worker did the thing".to_string());
        assert_eq!(s.delegation_state, DelegationState::Responding);
        assert_eq!(s.delegation_summary.as_deref(), Some("worker did the thing"));
    }

    #[test]
    fn reset_delegation_clears_state() {
        let mut s = OrchestrationState {
            delegation_state: DelegationState::Responding,
            delegation_summary: Some("stuff".to_string()),
            ..Default::default()
        };
        s.reset_delegation();
        assert_eq!(s.delegation_state, DelegationState::NotCalled);
        assert!(s.delegation_summary.is_none());
    }

    // ── Correct tool names in prompts ─────────────────────────────────────

    #[test]
    fn task_prompt_mentions_correct_tools() {
        let task = pending("t1", "do thing");
        let blocks = OrchestrationState::task_prompt(&task);
        let text = text_of(&blocks);
        assert!(text.contains("send_prompt"));
        assert!(text.contains("task_write"));
        assert!(text.contains("completed"));
        assert!(text.contains("t1"));
        // Should NOT reference phantom tools
        assert!(!text.contains("_send_task"));
        assert!(!text.contains("task_done"));
    }

    #[test]
    fn nag_delegate_mentions_correct_tools() {
        let blocks = OrchestrationState::nag_delegate();
        let text = text_of(&blocks);
        assert!(text.contains("send_prompt"));
        assert!(text.contains("task_write"));
        assert!(!text.contains("_send_task"));
        assert!(!text.contains("task_done"));
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

        // Agent delegates → _send sets WaitingForResponse
        s.set_waiting_for_response();
        assert_eq!(s.determine_next_prompt(), None); // loop pauses

        // Worker finishes → callback sets Responding with summary
        s.set_responding("did first task".to_string());

        // Agent marks t1 done via task_write (updates task_list)
        s.task_list[0].status = TaskStatus::Completed;

        // Next loop: responding + done → advance → start t2
        let b = s.determine_next_prompt().expect("start t2");
        assert!(text_of(&b).contains("second"));
        assert_eq!(s.current_task.as_ref().unwrap().id, "t2");

        // Simulate: agent delegates t2, worker finishes, agent marks done
        s.set_waiting_for_response();
        assert_eq!(s.determine_next_prompt(), None);
        s.set_responding("did second task".to_string());
        s.task_list[1].status = TaskStatus::Completed;

        // Next loop: advance → all done → summary
        let b = s.determine_next_prompt().expect("summary");
        assert!(text_of(&b).contains("All tasks are complete"));

        // Loop stops
        assert_eq!(s.determine_next_prompt(), None);
    }
}
