= TO DO


== ACP Chat specific
+ Get rid of echo of user message and improper formatting of user response
+ Proper syntax highlighting for typst (WYSIWYG?) and good @ context mechanism in the rich text editor. Enable scroll wheel. Resizing. Change the default color of the text to same white as text in chat.
+ Pull thinking tokens out of the weird scrollable box they're in and enable syntax highlighting for their thoughts
+ Add diff fixtures for edit and write
+ Add terminal fixture that is a "real terminal" in other words xterm.js
+ Make all text in chat brighter. it's a dark theme. can barely see text right now. too muted. 
+ Model selection in chat
+ TOOLS! Client side tools that do orchestration stuff. Cool orchestration tasks like 
  - list_sessions — list all the active sessions open in editor
  - send — send a message to another user. hooked up to state to say who it called so called agent replies back after react loop to execute task with a tool-less, RESTful summary
  - task_read — read from the task list
  - task_write — create, update, delete items from a todo task list that is tied into how the agents work, all of this will be described in great detail elsewhere but basically we have three tiers of agents and the middle agent is in charge of assigning and evaluating tasks and the task_write tool puts it in a loop where it has to move tasks to done or it gets a reply telling it to do the task or move to done until it does
  
+ Fixtures for the above client side tools and they will need to be integrated into crow-cli
+ ACP agent configuration and debugging view — configure different settings for agent
+ MCP server configuration and debugging view
+ Prompt editor configuration/plugin/extension for ACP — not an extension, part of contrib
+ Make "everything" configurable in settings json of IDE
+ A viewer/editor for the different queues we use
  - An editor/view for the normal queue of a standard agent
  - An editor/view for the task/todo list that the instructor/orchestrator/worker iterate over

== IDE specific
+ #strike[Rebrand. Go ahead and do it. Call it crow. Use the crow logo.]  
+ Bring tinymist extension or whatever into contrib and make a default .typ view just like markdown (and enable for markdown as well!)
+ ADD SCROLL TO TERMINAL!
+ Make highlighting text and adding quotes, parentheses, [, {, etc surround the highlighted text instead of replacing and be cautious of how that can clash with dedenting, copy over from vscode, sidex is very very rough on this. crow-ui has this. we might be able to learn from it lol.
+ Some kind of dirty indicator. Probably another one of these "learn from vscode/crow-ui how this works" situations lmfao. Hey at least they got git integration working for us.
+ 

// $ nabla dot arrow(E) = rho / epsilon_0 $