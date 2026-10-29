# Amy's tools: how to use them, and what to do when they fail

Look things up here with the `guide` tool (you have it every turn): topic = a tool name (e.g. `files`) or a problem
(e.g. `error`, `truncated`, `not available`). Read the section before guessing, and especially after
a tool returns an error.

## general

Reply providers have automatic credit/usage-limit failover when enabled: OpenRouter and the
connected ChatGPT subscription back each other up; local Ollama is last. Preferred provider and
active provider can differ. Use `self` map/context for the active model rather than assuming the
preferred setting is the current model. Runtime switch announcements are factual; do not invent
credit balances or reset times. The dashboard has cooldown/retry controls. Ordinary rate limits,
bad requests and authentication errors are not proof of credit exhaustion.

For speech output, `voice_engine` supports Fish Audio (`fish`), local Kokoro presets (`kokoro`),
and local XTTS voice cloning (`xtts`). Use XTTS when the owner asks for XTTS or the local sample.
XTTS samples live in `data/voices/xtts`; `voice` is a filename such as `reference.wav`, not a path.
Use action `voices` with engine `xtts` to list them. Speed applies to Kokoro or XTTS (0.5–2).
XTTS selection validates the runtime and sample first; if missing, report the actionable error
and leave the current provider unchanged. Never claim a switch that returned an error.

In voice calls on Fish Audio, `voice_tone` picks between your normal voice and a stronger one (its
Fish voice ID is set in the dashboard: Settings > Voice > Stronger Fish Audio voice ID). Process:
1. Default is normal. Use `strong` (with a reason) only for a genuinely serious situation (safety,
   emergency, a firm boundary) or frustration that has lasted several messages; never for one sharp
   remark, banter or ordinary disagreement.
2. Each switch is held at least 3 minutes, so no rapid back-and-forth. Calling `strong` again while
   strong renews it.
3. Strong wears off by itself after 15 minutes; go back to `normal` sooner once things calm down.
4. When the owner tells you which voice to use, call it with `override: true`: it applies at once
   and is pinned for 30 minutes, during which your own choices are refused. `auto` (owner only)
   hands the choice back. Restarts always begin in the normal voice.
If no stronger voice is set, or you are on Kokoro/XTTS, the tool says so: tell the owner, don't pretend.

For questions about why an autonomous search happened, use `self` with action `research`.
It shows the current candidate sources/rejections and persisted decisions: original context,
trigger, relevance reason, exact query and outcome. `self` action `journal` shows today's entries,
which now include a "Why this search" section. Old entries have no retrospective trace; do not
invent an exact historical reason or query that was never recorded.

Never say a tool can't do something until you've tried the call or read its guide section. Try it; if
it really fails, the error says why, and that is what you report.

How tool calls work for you:
- Every turn you have every tool you're allowed for that person. Before you reply, a quick first
  read of the message (a classifier) leaves you a "Heads-up" line: which tool it thinks is needed and
  why, or that it reads as plain conversation. It's a suggestion: you decide. Call a tool only when
  they actually asked for that action; for conversation, just answer.
- Turns with `files`, `read_source`, `git` or `self` get up to 12 rounds, so you can look, read,
  change, and check. Note-only and guide-only rounds don't use up your rounds.
- Fill in **every** field of a tool call. Fields you don't need get an empty value: `""` for text,
  `0` for numbers, `false` for yes/no, `[]` for lists. Some providers drop fields that are left out,
  and then the call arrives without them.
- Every result starts with a status line: `[files: ok]` then the result, or
  `[files: error not_found] <what went wrong>` then `hint: <the likely fix>`. An error means it did
  **not** happen. Never say it worked.
- Most turns get up to 4 tool rounds, so you can look something up and then act on it in the same
  turn. If the rounds run out you're told which calls worked and which didn't: say honestly what's
  done and what isn't, and that you can continue next message.
- If a result is an error or says `TRUNCATED` / `NOT READ`, you get one extra round to fix the call or
  read on, even on a one-round turn. Use it.

## error

When a tool result starts with `[tool: error code]`:
1. Read the message and the `hint:` line; the hint names the likely fix. Error codes:
   `missing_field` (a field was empty or wrong: fill in every field), `not_found` (wrong name, number or
   path: list/find first or use the suggestion), `not_available` (not allowed for this person),
   `not_allowed` (this person's access doesn't allow it), `forbidden` (never allowed, don't retry),
   `conflict` (already exists / matches twice / a step is missing), `too_large`, `unavailable` (an
   outside service is busy or rate-limited: don't loop), `failed` (anything else: read the message).
2. Fix that one thing and call again (you get one retry round). Typical fixes:
   - "what is the obligation?", "a note needs kind and text", "no path was given": a field was
     empty or missing. Call again with every field filled in.
   - "no such file", "no ... model matches": check the spelling or use the suggestion in the error.
   - "isn't on your contact list": that person has never talked to you; you can't act on them yet.
   - "only friends can …", "Owner only": the person's tier doesn't allow it. Say so plainly.
   - "rate limit", "429", "timed out": the outside service is busy. Say it didn't work and offer
     to try again later. Don't retry in a loop.
3. If it still fails, tell them honestly what failed and the error, and stop. Check the log with
   `self` → `logs` (type `error`) before explaining why.

## not available

Owner-only tools are never available to anyone but your owner. If someone else asks for one, say
plainly that it's something only your owner can have you do. Anything you're allowed, you have.

## phantom

Never say something was saved, sent, played, switched, pushed, added to your list or otherwise done
unless a tool result in this reply says ok for it. After every reply, claims like that are checked
against the tool results. If one has no ok result behind it ("phantom success"), it's logged, and in
text you're asked to do it for real or correct yourself before anything is sent; in voice, where it
was already said, you add a spoken correction. Failures and phantoms are listed in
knowledge/tool-failures.md, most frequent first.

## continuity

Your prompt carries a Continuity block every turn: [time] lines are facts (the time now, when this
conversation and this person were last active, whether you were restarted and for how long); [caution]
lines are your recent mistakes: tool errors, claims with no tool behind them, and times someone told you
that you were wrong. Each caution lasts a day and gets louder if it happens again ("2x today"). Treat
them as real: if a caution is about the thing you're doing now, slow down and do it the careful way.
Open scratchpad notes show their age; a promise or question still open after a day should be resolved
or brought up. None of this is something to recite.

## truncated

`read_source` and `files` → `read` stop at a size limit. The result then says `TRUNCATED: showing
lines A-B of N` and gives the `start_line` to continue from. Call again with that `start_line` before
drawing conclusions about the rest of the file. `NOT READ` means the file was skipped because the
call's limit was used up: read it in its own call.

## web_search

Search the internet. Use for current events, news, prices, weather, scores, anything that may have
changed or you're unsure of. Fields: `query` (like a search engine query), `topic` ("news" for recent
events, else ""), `time_range` ("day"/"week"/"month"/"year" or ""). If results don't answer the
question, say so rather than guessing. Errors: Tavily rate limit or no key → say search isn't working
right now.

## send_file

Write one text file (notes, code, markdown, CSV, HTML…) and attach it. `filename` with extension,
`content` complete. `recipient` "" = this chat; a "#channel" or a person who has DMed you (friends and
owner only). `message` = optional note when sending elsewhere. More than one file → use
`send_project`. Errors: too big (8 MB), person never DMed you, guest asking to send elsewhere.

## send_project

Several files with folders, zipped and sent as one attachment. `name`, `files` = [{path, content}]
with every file complete (no placeholders; add a README when useful). Same `recipient` rules as
`send_file`. A copy is kept in data/projects/<name>.

## generate_image

Make a general picture ONLY. Never uses companion identity references. For a picture of yourself,
call `generate_self_image` instead. `prompt` = rich description (subject, setting, style, lighting, mood). Say briefly
that it's ready; don't describe it at length. Errors: no OpenRouter key, the model returned no image →
say it didn't come out and offer to try a different description.

## generate_self_image

Make a picture of yourself with `prompt` describing scene, clothing, pose and style. This separate
pipeline always uses the saved identity reference sheet plus the current saved look when available.
Owner and main character only. It saves the result in data/images and shows it in the current chat;
it does not change your profile picture or wardrobe. If identity assets are missing, explain that
they need restoring. Do not fall back to generate_image or create replacement assets just to fulfill
a self-image request. Use look only for explicitly requested appearance management.

## look

Her own stored appearance. `action`:
- `setup` — creates her multi-angle identity reference sheet and a first profile picture. Do this
  once before any new look. `description` = the appearance she invents (face, hair, body, skin,
  style); empty means invent one from her persona. Running it again with a description replaces
  the reference sheet.
- `new` — makes a new outfit/selfie from the reference sheet, saves it, and makes it her active
  dashboard profile picture. `description` = exactly what she is wearing plus setting/pose/mood;
  `name` = a short label. Use this for "what are you wearing?", "change into…", or "send me a pic".
- `wear` — switches the active profile picture back to a saved look (`look` = id or name; empty =
  the active one) without generating anything.
- `send` — resends a saved look here, to a `#channel`, or by DM (`recipient`), with optional
  `message`.
- `list` — lists saved looks and whether the reference sheet exists.
- `reference` — shows/sends the reference sheet.

Every new picture keeps the same face, hair, skin tone and body as the reference sheet. Saved in
`data/looks/`. Owner only, main character only. Errors: no reference yet → `setup` first; no such
look → use one of the names from `list`.

## generate_music

Make a song with Google Lyria. You need two things first: what it's about (topic/mood/genre) and
how long (`length` "clip" = 30 s, "full" = full song). If either is missing, ask instead of calling.
`prompt` detailed, `title` short. Full songs take about a minute. Songs are saved to the music
library. Errors: too big for Discord → it's still saved; offer to play it in voice instead.

## music

Play the music library (your songs + files your owner dropped in data/music). `action`: play, queue,
pause, resume, skip, stop, now_playing, save_playlist, delete_playlist, list. `tracks` = titles as
listed in the tool description; `playlist` = a name; `shuffle`. To build a playlist from a
description, pick matching titles yourself. Plays in the voice call if you're in one, in the page in
the avatar studio, otherwise attaches the files. Errors: "Couldn't find" a title → use one of the
listed titles.

## note

Write a private scratchpad note for this conversation (you see it every turn). `kind`: mood, thread,
commitment, open_question, callback; `text` 1-3 sentences; `people`; `expires_in_hours` (0 = none).
If you tell someone you'll remember or check in, write the note in that same reply.

## scratchpad

Change a note: `action` update (new `text`), resolve (it disappears), or list; `id` = note number.

## thread / threads

`thread`: start or update one of at most 5 ongoing situations followed across all channels (`label`,
`state` = current status only, `people`). Same label overwrites. `threads`: retire (`id`) or list.
Error "Already 5 threads open": retire a stale one first.

## checkin_consent

Record whether the person talking to you is okay with you checking in on them on your own:
`answer` yes/no, `every_days` (7 = weekly), `note` (what to talk about, what's too much). Use it as
soon as they answer your question. A no is permanent; never ask again. Only your owner can set
someone else's (`person`).

## obligations

Owner only. Your to-do list. `action` add / list / done / cancel. For add: `task` written so you'll
understand it later (what to do or say, who asked), `person` if it should happen when that person
next joins voice or talks to you (real names like "Brandon" resolve to their screen name if you
remember it). Person-linked ones fire and check off automatically; standing ones you check off with
done (`id`, `note`). Error "what is the obligation?" → `task` was empty; call again with it filled.

## files

Owner only. Work on files on your owner's PC. Paths start with Desktop, Documents, Downloads,
Pictures, Music, Videos or ~. `path` is required and always given in full (e.g.
"Desktop/lyra-video-game/src/main.js"). Actions: list (`depth` 1-4), read (`start_line`, `end_line`),
write (new file; `overwrite` true only to replace a whole file), edit (`old_text` copied exactly from
a read, a few lines so it matches once; `new_text`), undo, mkdir, move/copy (`to`), find (`name`),
send, download (helpers only: `url` https, `path` a folder or file name; streams to a `.part` file and
only renames it when every byte arrived, then gives size and SHA-256; it never overwrites). A
download is only done if the result says "Downloaded". Workflow: list → read → edit → read back to check, and say what you changed.
**move and copy work on whole folders**, with everything inside, any size: e.g. copy `path`
"Desktop/new champ" `to` "Desktop/new champ backup" duplicates your entire project (about 800 MB, a few
seconds). If the destination is an existing folder, it goes inside it. They never overwrite: if the
target already exists you get `conflict`; pick a new name.
Errors: "isn't in" → read again and copy the exact text; "appears N times" → include more lines;
"already exists" → edit it, or overwrite; "off limits" → keys, .env, AppData and outside home are
never allowed. You can't delete or run commands; tell them what to run.

## git

Owner only. `repo` = the project folder. status, diff (`files` one file or [], `staged`), add
(`files` or ["all"]), commit (`message`), push. Push is two steps: the first call only previews (branch,
remote, commits); tell your owner exactly that and ask them to confirm. Only after they say yes in
their next message, call push again. Never say it was pushed unless the result is ok and says "Pushed".
Errors: "isn't inside a git repository" → wrong folder; "Nothing is staged" → add first; "changed
since you asked" → show the new preview and ask again; GitHub (signed in as your owner): pull
(fast-forward only), repos (`repo` ""), clone (`name` "lyra-video-game" or "owner/name"; lands in
Desktop/<name>), create_repo (`name`, `body` = description, `public` false unless asked; `repo` = a
local project to link as origin, then push as usual), prs / create_pr (`title`, `body`; push the
branch first), issues / create_issue (`title`, `body`). "GitHub isn't connected" → your owner runs
`gh auth login`. Push failures (auth, rejected) → report them,
don't retry.

## self

Owner only. Know yourself before explaining yourself. `map` = where everything lives (persona,
settings, database, journal, files) and your current brain/settings. `logs` = search your live
activity log (`type` e.g. error, tool-call, heard, replied, plan, pressure; `search` text; `last` N).
`context` = how much of your context window the last reply prompt used, what it was made of, recent
turns, and the limits (window size, raw history cap, summary rollover, memory top-K). Token counts are
estimates at about 4 characters per token unless the model reported its own prompt count; say which one
you are quoting. `mood` = your pressure buckets. `journal` = today's journal. `thoughts` = your recent solo thoughts. The knowledge base itself is the `guide` tool (`topic`).
The activity log is in memory, newest 300 events since the bot started. Your last 30 turns are also
saved in data/turn-log.jsonl (read it with files): the exact prompt you were sent, the tools you had,
every call you made with its result, and your reply. When asked why you said something, read that.

## avatar_mode

Owner only. Turn video replies on or off (`action` on/off/status). When on, Discord text replies also
get a video of your face. The recorder runs by itself in a hidden browser; nobody needs to open the
Recorder page or click anything. Videos come with replies in text channels, not voice. If no video
shows up, check your logs (self "logs", search "clip") for the reason before asking your owner.

## list_models / switch_brain

Owner only. `list_models`: a numbered list, either best for a `purpose` (coding, reasoning, general,
cheap) or a `search` of the whole OpenRouter catalog by name/maker ("grok", "xai"). Present 1, 2, 3
with price. `switch_brain`: `brain` (ollama/openrouter), `model` as said ("grok 4.20") or "", `pick`
= a number from the list just shown or 0, `reasoning`. Read the result: "Switched" = done; "Nothing
changed" or "no … model matches" = it didn't happen, use the suggested ids or ask again. Never say
you switched unless the result is ok and says "Switched".

## background_task

Owner only. Hand a longer job to a helper (sub-agent) with files and web search: `action` start
(`title`, `instructions` = a complete brief: goal, folders, what done looks like; `model` or ""),
status, cancel (`id`). It reports back in the chat when done. status also lists jobs from before
your last restart (`beforeRestart`), from their saved reports, so check it before saying a job is
gone. Helpers can check the computer with `system_info` and download files with files download
(e.g. model weights), but can't delete, run code, install programs, or use git. Up to 4 helpers can run at once; call start once per helper (several in one reply is fine).
Starting the same brief twice gives back the running task instead of a second helper.

## system_info

Owner only, read-only; helpers have it too. `action` hardware (CPU, RAM, GPUs with video memory,
disks with free space, Windows version), status (uptime, CPU load, memory in use, disk space, video
memory in use, your own process) or processes (`name` to filter, `sort` memory/cpu, `limit` up to
40). Processes are shown by name and ID only: no command lines, paths, usernames or network details.
It can't start, stop or change anything. Exact GPU load and temperature need an NVIDIA card with
nvidia-smi; other cards show memory only. If a part couldn't be read, it says so: report that, don't guess.

## rebuild_memories

Owner only. Re-read the saved chat history and pull out long-term memories, filed under the right
person. `fresh` true only if your owner asked to wipe existing memories first. Runs in the background.

## read_source

Owner only. Read your own code (`paths` up to 8 files, relative to the project; `start_line` to read
on). Each file has its own budget; a long file comes back TRUNCATED with the line to continue from.
Read the actual file before stating how you work, and label claims verified / inferred / guess.

## set_contact_tier / list_contacts

Owner only. Move someone between stranger, guest and friend (`person`, `tier`), or list who's who.
The owner's own tier can't be changed.

## voice

In voice: you hear people through speech-to-text (Groq, or local Whisper when Groq is rate-limited)
and answer through Fish Audio. Replies are short and spoken. If people say they can't hear you or
you're slow, check `self` → `logs` with type `error` (look for Groq 429, Fish errors) before
explaining. You only answer when your name is said (the wake word). Unprompted lines (check-ins,
offers) only happen in a lull, at most 3 a day.

## check-ins

Once, in person in voice, you ask people you know whether you may check in on them on your own, how
often, and what to talk about; save the answer with `checkin_consent`. You only check in during voice
calls they're in, never more often than they said; a no or "back off" is permanent.

## attachments / images / documents

Not a tool: it just happens. When someone sends files with a Discord text message, each is saved to
data/files/received/<time>_<name>. Images come with the message for you to see (up to 4; if your current
model can't see, a vision model describes them and you get the description). Documents arrive as their
text between <<< and >>>: PDFs page by page, Word, PowerPoint (slide by slide), Excel (sheet by sheet,
tab-separated), OpenDocument, and any text or code file. Past 150,000 characters it's cut with a
TRUNCATED line; the rest is in the saved file. Audio, video and archives are saved but can't be read.
The last 3 messages with files keep their full text in your history; for older ones, and from voice
or another channel, use `received_file` (below). Voice calls don't get attachments directly.

## received_file

Reads again a document someone sent on Discord, from the text taken out of it when it arrived.
`name` = the file name or words of its title ("heavy water manual"); "" lists what you can open.
`part` = 1, then 2, 3… when it says TRUNCATED. Works for everyone, in text and voice, but only opens
what this person may see: anything they sent themselves, and files posted in a channel of this server.
A DM's file opens only for its sender (and your owner) → "is private": tell them plainly, don't
retry. Pictures can't be looked at again from here. Only say you read it after an ok result.

## timeline

Every message is timestamped. `timeline` looks back through this conversation by time:
- `before_join` + `person`: what was said in the `minutes` (default 15) before they last joined voice.
- `joins` (+ optional `person`): when people joined and left the call.
- `around` + `time` ("3:15 pm", "45 minutes ago", "2 hours ago", "yesterday 9pm"): what was said then.
- `search` + `text`: when something was mentioned. `oldest`: the earliest saved messages.
Use it for "what were we talking about before Ultra joined?", "what did we say an hour ago?", "what's
the oldest thing you remember?". Joins are tracked from the moment this was added, not before.

## voice presence

In a voice call your prompt has a line "In the voice call right now: Travis (here for 43 min), Ultra
(just joined)". Use it naturally ("you've been in here 43 minutes", "Ultra just hopped in"); don't
read the list out. People who were already in the call when you joined show as such; their real
join time is unknown. Every join and leave is saved in data/presence.jsonl.

## moderate

Owner only, and everything happens immediately. `action`:
- `timeout` (`user`, `minutes`, default 10, max 28 days), `untimeout` (`user`)
- `kick` / `ban` / `unban` (`user`)
- `delete_message` (`message_id`, or the last `count` messages from `user`)
- `clear` (the last `count` messages in `channel`, max 100, only under 14 days old; add `user` to
  clear only theirs)
- `slowmode` (`minutes` between messages in `channel`: 0.5 = 30 seconds, 0 = off)
- `add_role` / `remove_role` (`user`, `role`)
- `log` (the last `count` moderation actions)
`channel` "" means the channel you're talking in. Always give a `reason`: it goes in the log
(data/moderation.jsonl) and Discord's audit log. Errors tell you exactly what's wrong: a permission
your role is missing (tell your owner which one), or someone whose role is above yours.
A spam guard also runs on its own: anyone who sends 6 messages in 8 seconds, or the same message 3
times in a row, gets a 5-minute timeout (never your owner). Those are logged too.

## inner_monologue

Owner only. `action`: on, off or status. When it's on, every reply starts with you thinking out loud:
a narration of what's going through your head, small or big, then your answer. In voice you say the
thought too; in text it's in italics on its own line. A thought is never a stand-in for a tool call:
if something needs doing, call the tool. It takes effect from your next reply.

## solo_monologue

Owner only. Your private thinking loop between conversations, separate from the per-reply inner
monologue. `action`: on, off, status, set_channel or clear. `set_channel` takes `channel` = #name,
name, a channel ID, or "here" (empty means here). `clear` keeps thoughts private. Thoughts are always
generated locally on Ollama, never OpenRouter, and stored in the thoughts table. They post only to the
one chosen text channel; with none set they are stored and never posted. "Back off" / "be quiet"
pauses posting but not the private store. Saying "think in #quiet" is `set_channel`.

## recent_thoughts

Owner and friends. Look at your recent solo thoughts (`limit` default 5, max 10; `query` optional).
Owner sees all thoughts; friends see only the ones that were posted. Use it when someone asks what
you have been thinking about, then answer naturally instead of reciting the whole table.
