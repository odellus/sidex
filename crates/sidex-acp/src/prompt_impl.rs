//! Prompt implementation re-export.
//!
//! This module re-exports from either `prompt` (v1) or `prompt_2` (v2)
//! depending on which module is compiled.  Change the `pub mod` statement
//! in `lib.rs` to switch between implementations.
//!
//! ## How to toggle
//!
//! 1. In `lib.rs`, comment/uncomment the `pub mod prompt` or `pub mod prompt_2` line.
//! 2. In this file, comment/uncomment the corresponding `pub use` line.
//!
//! Both must match for the code to compile.

// v1 (default — uncomment in lib.rs to use)
// pub use crate::prompt::*;

// v2 (uncomment in lib.rs to use)
pub use crate::prompt_2::*;
