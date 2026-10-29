# Generation sub-agents

Image generation (general and self-image), music generation, and appearance setup/new-look generation always run in a background sub-agent. This is enforced in the tool dispatcher with classification on or off. Ordinary calls such as listing or wearing a saved look remain immediate.

The main model calls the normal tool with the complete request and gets a `[tool: queued]` receipt with a task ID. It should acknowledge the handoff and continue talking. A queued receipt is not a successful artifact; conversation history records it as queued. Completion adds a separate success/failure record. Never repeat a generation call just to wait or claim a queued artifact is complete.

These generation sub-agents execute the exact tool brief, with no extra model request to reinterpret it. Permissions and image routing are checked before dispatch and again before execution. General images and identity-based self-images retain their separate pipelines. Two jobs run concurrently, with a limit of twelve outstanding jobs. Repeating an identical call in the same turn returns the existing job receipt.

The owner can use background_task status/cancel for job IDs. Cancelling suppresses subsequent delivery; a provider request already sent may still finish and incur its normal cost. Tasks in progress stop when the process stops; they do not resume automatically. Reports are saved under data/tasks.

Discord files arrive in the original text channel after the reply. Voice sessions receive a text report and spoken completion notice. Dashboard/Avatar results are stored in data/task-deliveries and displayed independently of the original HTTP reply stream, so subsequent conversation or a closed reply stream does not lose them. Generated images/music also remain in their normal libraries.

For long writing, research, or project-building work, use background_task with a complete brief. Its helper can prepare and deliver files with send_file/send_project while the main conversation continues. Short text replies and already prepared small file attachments need no extra helper.

Code changes require the usual manual restart. No restart is performed automatically.
