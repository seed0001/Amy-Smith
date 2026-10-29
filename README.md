# Amy

**A Discord AI companion that talks in text and voice, remembers people, has moods and a 3D face, makes pictures and music, reads the news, manages your server, and can work on your projects.**

Amy is a self-hosted Node.js bot. She runs on your own PC, keeps everything she learns in a local SQLite database, and can think with a local model (Ollama) or a cloud one (OpenRouter, Mistral, or a ChatGPT subscription). She isn't a command bot: you just talk to her, and she decides which of her ~40 tools to use.

---

## Contents

- [Highlights](#highlights)
- [How she works](#how-she-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Configuration (.env)](#configuration-env)
- [Running her](#running-her)
- [Features in detail](#features-in-detail)
  - [Conversation and memory](#conversation-and-memory)
  - [Voice](#voice)
  - [Brains (language models)](#brains-language-models)
  - [Pictures](#pictures)
  - [Music](#music)
  - [News feeds (RSS)](#news-feeds-rss)
  - [Web search and research](#web-search-and-research)
  - [Background helpers](#background-helpers)
  - [Files and projects on your PC](#files-and-projects-on-your-pc)
  - [Git](#git)
  - [Server moderation](#server-moderation)
  - [Inner life: moods, pressure, thoughts, journal](#inner-life-moods-pressure-thoughts-journal)
  - [Dashboard](#dashboard)
  - [Avatar studio and video replies](#avatar-studio-and-video-replies)
  - [The doctor and life support](#the-doctor-and-life-support)
  - [Reliability](#reliability)
- [Slash commands](#slash-commands)
- [Permissions and safety](#permissions-and-safety)
- [Where things are stored](#where-things-are-stored)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Highlights

- **Talks like a person, not a command bot.** Replies to DMs, @mentions and every message in channels you choose. In voice she listens to everyone, answers out loud, and stops when you talk over her.
- **Remembers.** Long-term memories per person (semantic recall with local `bge-m3` embeddings), rolling conversation summaries, profile cards with likes, dislikes and how things have been going between you.
- **Has an inner life.** Moods that follow the conversation, "pressure" buckets (boredom, curiosity, loneliness and more) that make her want things, private solo thoughts, and a research journal.
- **Switchable everything, by asking.** "Switch to OpenRouter and use Kimi", "use your local voice", "use Kontext for pictures", "go back to Gemini". Settings persist across restarts.
- **Local-first options.** Local brain (Ollama), local speech-to-text (Whisper or Parakeet), local voices (Kokoro, XTTS v2 voice cloning), local image generation (FLUX.1 Kontext via stable-diffusion.cpp on Vulkan).
- **Makes things.** Pictures (cloud or local, including pictures of herself that keep her face), songs with Google Lyria 3, files and whole projects on your PC.
- **Reads the news.** Pulls RSS/Atom feeds on request and talks about what's new.
- **Runs your server.** Warn, time out, kick, ban, channels, roles, invites, slowmode, with an automatic spam guard.
- **Keeps herself running.** Life support restarts her when she stops, DMs you if she can't start, and the "doctor" (Claude Code) can fix her own code on your say-so.

---

## How she works

```
Discord text / voice ─┐
Dashboard chat ───────┼─► companion.js ─► turn classifier (which tools, if any)
Avatar studio ────────┘        │
                               ├─► prompt: persona + capabilities + continuity + mood
                               │           + recalled memories + summaries + history
                               ├─► brain (Ollama / OpenRouter / Mistral / ChatGPT), streamed by sentence
                               │      └─► tool calls (up to 4 rounds; 12 for file/code work)
                               ├─► claim check: anything she says she did is checked against tool results
                               └─► memory extraction, profile learning, mood update
```

- **Voice:** Discord audio → speech-to-text → the same pipeline → text-to-speech → back into the call, sentence by sentence, so she starts talking before the whole reply is written.
- **Tools** are plain functions in `src/tools.js`. Each declares who may use it (owner, friends, guests) and when it's available. The model sees only the tools allowed for that person, that turn.

---

## Requirements

| What | Why | Notes |
|---|---|---|
| **Windows 10/11** | Start scripts, life support, local runtimes | The core runs on any OS with Node; the `.bat`/`.ps1` scripts are Windows. |
| **Node.js 22+** | Runs her | Developed on Node 24. |
| **A Discord application** | Her account | Needs the Message Content and Server Members intents. |
| **Ollama** | Local brain and memory embeddings | Pull `bge-m3` (embeddings, always needed) and a chat model, e.g. `gemma4:12b`. |
| **FFmpeg** on PATH | Voice audio | Encodes and decodes speech for Discord. |
| **Fish Audio key** | Cloud voice (default TTS) | Optional if you use Kokoro or XTTS. |
| OpenRouter key | Cloud brains, images, music, vision | Optional but unlocks a lot. |
| Tavily key | Web search | Optional. |
| Groq key | Fast cloud speech-to-text | Optional; local Whisper is the default. |
| Python 3.12+ | XTTS, Parakeet, FLUX.2 runtimes | Only for those optional local features. |
| Claude Code CLI | The doctor | Optional; uses your own Claude login. |

---

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications and create an application.
2. **Bot** tab: click **Reset Token** and copy it (this is `DISCORD_TOKEN`). Under *Privileged Gateway Intents*, turn on **Message Content** and **Server Members**.
3. **General Information**: copy the **Application ID** (this is `CLIENT_ID`).
4. **OAuth2 → URL Generator**: tick `bot` and `applications.commands`. Under bot permissions tick **Administrator** if you want moderation (create/delete channels and roles, kick, ban). *View Channels, Send Messages, Read Message History, Connect, Speak* is enough for chat and voice only. Open the generated URL to invite her.
5. In Discord, turn on Developer Mode (Settings → Advanced), then right-click yourself → **Copy User ID**. This is `OWNER_IDS`. The owner is the only person who can use her powerful tools.

### 2. Get the local pieces ready

```bash
ollama pull bge-m3
```

```bash
ollama pull gemma4:12b
```

Make sure `ffmpeg -version` works in a terminal.

### 3. Clone and install

```bash
git clone https://github.com/seed0001/Amy-Smith.git
```

```bash
cd Amy-Smith
```

```bash
npm install
```

### 4. Create `.env`

Create a file called `.env` in the project folder. The minimum to get her talking:

```ini
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-server-id
OWNER_IDS=your-discord-user-id
BOT_NAME=Amy
CHAT_CHANNEL_IDS=channel-id-where-she-answers-everything
OLLAMA_MODEL=gemma4:12b
OLLAMA_EMBED_MODEL=bge-m3
FISH_API_KEY=your-fish-audio-key
DASHBOARD_PORT=3000
DASHBOARD_HOST=127.0.0.1
```

Every other setting is listed in [Configuration](#configuration-env). `.env` is git-ignored; never commit it.

### 5. Give her a personality

Create `persona.md` in the project folder and describe who she is in plain words: her name, personality, how she talks, what she cares about. You can also write it in the dashboard (Settings → Persona). If `PERSONA_SELF_EDIT=true`, friends can change it by asking her. `persona.md` is git-ignored because she edits it herself.

### 6. Register slash commands and start

```bash
npm run deploy
```

```bash
start.bat
```

The dashboard opens at http://127.0.0.1:3000 once she's up.

---

## Configuration (.env)

Settings you change in the dashboard or by asking her are saved to `data/settings.json`, which overrides `.env`.

### Discord

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token. Required. |
| `CLIENT_ID` | — | Application ID, for registering slash commands. |
| `GUILD_ID` | — | A server ID. Commands register there instantly; blank registers globally (slow). |
| `OWNER_IDS` | — | Comma-separated Discord user IDs with full access. |
| `BOT_NAME` | `Champ` | Her name. Set it to `Amy`. |
| `CHAT_CHANNEL_IDS` | — | Channels where she replies to every message. She always answers DMs and @mentions. |
| `HISTORY_LIMIT` | `100` | Recent messages per conversation she sees with each reply. |
| `THOUGHT_CHANNEL_ID` | — | Where her solo thoughts are posted (blank keeps them private). |

### Brain

| Variable | Default | What it does |
|---|---|---|
| `BRAIN` | `ollama` | Who writes replies: `ollama`, `openrouter`, `mistral` or `chatgpt`. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama address. |
| `OLLAMA_MODEL` | `gemma4:12b` | Local chat model. |
| `OLLAMA_EMBED_MODEL` | `bge-m3` | Embeddings for memory recall. Always local. |
| `OLLAMA_NUM_CTX` | — | Local context window in tokens. Raise it; Ollama's 4096 default is small. |
| `OLLAMA_THINK` | — | Let thinking-capable local models reason first. |
| `OPENROUTER_API_KEY` | — | https://openrouter.ai/keys (starts `sk-or-`). |
| `OPENROUTER_MODEL` | — | Cloud model for replies. |
| `OPENROUTER_REASONING` | `medium` | How hard reasoning models think: `none`, `low`, `medium`, `high`. |
| `OPENROUTER_VOICE_REASONING` | `none` | Same, for spoken replies (reasoning delays the first word). |
| `OPENROUTER_VISION_MODEL` | — | Looks at pictures when her own model can't. |
| `MISTRAL_API_KEY` / `MISTRAL_MODEL` | — | Mistral's cloud; the free Experiment plan works. |
| `CHATGPT_MODEL` / `CHATGPT_FAST_MODEL` | — | Models for the ChatGPT subscription brain (sign in from the dashboard). |
| `TOOL_ROUNDS` | `4` | Tool rounds per reply. |
| `INNER_MONOLOGUE` | — | Turn her per-reply inner monologue on or off. |

### Voice

| Variable | Default | What it does |
|---|---|---|
| `TTS_PROVIDER` | `fish` | `fish` (cloud), `kokoro` (local presets) or `xtts` (local voice cloning). |
| `FISH_API_KEY` | — | https://fish.audio API key. |
| `FISH_VOICE_ID` | — | Voice model ID (blank picks a default). |
| `FISH_STRONG_VOICE_ID` | — | A second, stronger voice for serious moments. |
| `FISH_TTS_MODEL` / `FISH_LANGUAGE` | — | Fish model and language. |
| `KOKORO_VOICE` / `KOKORO_SPEED` | `af_heart` / `1` | Local Kokoro preset and speed. |
| `XTTS_REFERENCE` / `XTTS_LANGUAGE` / `XTTS_SPEED` | — / `en` / `1` | XTTS sample file, language, speed. |
| `STT_PROVIDER` | `local` | Speech-to-text: `local` (Whisper), `parakeet` (local), `groq` (cloud) or `fish`. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` | — / `auto` | Local Whisper model and device. |
| `GROQ_API_KEY` / `GROQ_STT_MODEL` | — | https://console.groq.com/keys (starts `gsk_`). |
| `VOICE_CHANNEL_IDS` | — | Voice channels `/join` may use (blank = any). |
| `VOICE_SILENCE_MS` | `800` | How long a pause ends someone's turn. |
| `VOICE_WAKE_WORD` | — | If set, she only answers in voice when addressed by it. |
| `VOICE_BARGE_IN` | `true` | Stop talking when someone talks over her. |
| `VOICE_JOIN_GREETING` | `true` | Read the room and say one natural hello on joining. |
| `VOICE_POST_TRANSCRIPTS` | — | Post what she says in voice to the text channel. |

### Pictures, music and video

| Variable | Default | What it does |
|---|---|---|
| `IMAGE_PROVIDER` | `openrouter` | `openrouter` (cloud), `kontext` (local FLUX.1 Kontext) or `flux` (local FLUX.2 klein). |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | Cloud image model. |
| `KONTEXT_SD_EXE` / `KONTEXT_MODEL` / `KONTEXT_STEPS` | `~/sd-cpp/sd-cli.exe` / `~/FLUX1-Kontext/flux1-kontext-dev-Q4_K_M.gguf` / `20` | Local Kontext runtime, model and steps. |
| `FLUX_MODEL_DIR` / `FLUX_PYTHON` | `~/FLUX2-klein-4B` / runtime venv | Local FLUX.2 klein model and Python. |
| `OPENROUTER_CLIP_MODEL` / `OPENROUTER_SONG_MODEL` | Lyria 3 clip / pro | Music models. |
| `AVATAR_PATH` | `data/avatar.glb` | 3D avatar file. |
| `AVATAR_VIDEO` | `on` | Add a video of her face saying her text replies. |
| `AVATAR_BROWSER` | — | Browser used for the hidden video recorder. |

### Search, news and dashboard

| Variable | Default | What it does |
|---|---|---|
| `TAVILY_API_KEY` | — | https://app.tavily.com (starts `tvly-`). Blank turns web search off. |
| `TAVILY_DEPTH` / `TAVILY_MAX_RESULTS` | `basic` / — | Search depth and result count. |
| `RSS_ENABLED` | `true` | Turn the news feed tool on or off. |
| `RSS_POLL_MINUTES` | `60` | Minimum gap between pulls of one feed. |
| `DASHBOARD_PORT` | `3000` | Dashboard port. |
| `DASHBOARD_HOST` | `127.0.0.1` | Keep it local. If you change it, set a password. |
| `DASHBOARD_PASSWORD` | — | Required for any remote access (e.g. Cloudflare Tunnel). |
| `PERSONA_SELF_EDIT` | — | Let friends change her personality by asking. |
| `SCRATCHPAD_TTL_HOURS` | `24` | How long idle working notes last. |
| `CLAUDE_PATH` | — | Path to the Claude Code CLI, for the doctor. |

---

## Running her

| How | What it does |
|---|---|
| `start.bat` | The normal way. Starts Ollama if needed, installs dependencies, registers slash commands, opens the dashboard, and runs her under **life support** (restarts her when she stops). |
| `watchdog.bat` | Like `start.bat`, but also restarts her whenever `src/`, `knowledge/`, `persona.md`, `package.json` or `start.bat` change. It won't restart her while the doctor is mid-visit. |
| `npm run dev` | Runs her directly with Node's file watcher. No life support. |
| `npm start` | Runs her directly once. |
| `npm run deploy` | Registers the slash commands. |
| `npm test` | Runs the test suite. |

---

## Features in detail

### Conversation and memory

- **Where she talks:** DMs, @mentions, and every message in `CHAT_CHANNEL_IDS`.
- **Short-term:** a rolling history per channel or voice session; older messages roll into summaries so long conversations don't overflow.
- **Long-term memories:** after each exchange she saves facts about each person and recalls the relevant ones semantically. `/memories list` shows yours; `/memories forget` removes them.
- **Profile cards:** every contact gets a card with likes and dislikes (only from things they say about themselves), frustration level with a decay half-life, interruptions, apologies, repair promises and appreciation. It colours her tone, never permissions.
- **Trust tiers:** stranger, guest, friend, owner. The owner sets tiers by telling her ("make Sam a friend"). Tiers decide which tools someone can use.
- **Continuity:** every reply knows the time, how long since you last talked, whether she was restarted, and her recent mistakes (so she doesn't repeat them).
- **Working notes:** a private scratchpad per conversation and up to 5 active threads that follow her across channels. Not long-term memories.
- **Timeline:** "what were we talking about before Sam joined?", "what did we say an hour ago?"
- **Memory rebuild:** "go through the chat history and rebuild your memories" (add "wipe them first" to start clean). Runs in the background.

### Voice

- `/join` puts her in your voice channel; `/leave` takes her out.
- She listens to everyone, transcribes speech, answers out loud and stops if you talk over her. Unfinished points can be picked back up after a quiet moment; "stop talking" or "be quiet" cancels them.
- **On joining** she reads the room: greets people she knows by name, introduces herself to new people, picks up where you left off.
- **Text-to-speech, switchable by asking:**
  - **Fish Audio** (cloud): any Fish voice, plus an optional stronger voice she switches to for serious moments.
  - **Kokoro** (local): free presets, adjustable speed. "Use your local voice", "use af_bella".
  - **XTTS v2** (local voice cloning): put a clean 6–30 second clip in `data/voices/xtts/reference.wav`, run `scripts/setup-xtts.ps1` once, then say "use XTTS".
- **Speech-to-text:** local Whisper (default, free), local Parakeet TDT 0.6b (`scripts/setup-parakeet.ps1`), Groq cloud Whisper, or Fish ASR.
- She can also hear what's going on in the server's text channels during a call ("what are people talking about?").

### Brains (language models)

- **Ollama** (local, free, private), **OpenRouter** (hundreds of cloud models, including big reasoning ones), **Mistral**, or your **ChatGPT subscription** (sign in from Settings → Brain; no API billing).
- **Switch by asking:** "switch to OpenRouter and use Kimi", "go back to local". "What are the best coding models?" gives a numbered list from OpenRouter; "go with 2" switches.
- **Automatic failover:** if OpenRouter runs out of credits she tries ChatGPT, and vice versa, then local Ollama. She says when she switches.
- Memory embeddings, memory extraction and solo thoughts always stay local.

### Pictures

Two separate tools, so ordinary pictures never use her identity and pictures of her always do:

- **`generate_image`:** any picture from a description.
- **`generate_self_image`:** pictures of *her* (selfies, portraits, scenes), using her saved reference sheet and current outfit so her face stays the same. Owner only.
- **`look`:** manage her appearance on purpose: reference sheet, outfits, profile picture. The dashboard's Looks tab shows them.

**Choose the image model by asking** ("use Kontext", "use the local model", "switch back to Gemini", "use GPT image"):

| Provider | Runs on | Reference images | Setup |
|---|---|---|---|
| `openrouter` (default) | Cloud | Yes | Just an OpenRouter key. Any OpenRouter image model, chosen by name. |
| `kontext` | Your GPU, via Vulkan | Yes (instruction editing) | Download the stable-diffusion.cpp Vulkan build to `~/sd-cpp` and FLUX.1 Kontext dev GGUF + `clip_l`, `t5xxl_fp8_e4m3fn` and `ae` to `~/FLUX1-Kontext`. Works on AMD cards with the normal driver; no ROCm or PyTorch. |
| `flux` | Your GPU, via PyTorch | Yes | FLUX.2 klein 4B in `~/FLUX2-klein-4B`, then `scripts/setup-flux.ps1` (AMD ROCm build of PyTorch for RX 9000 cards). Needs a driver that matches the ROCm build. |

She won't switch to a local model whose files are missing; she tells you what's missing instead. Local pictures take a minute or two; the first one is slower while the model loads. Images are saved in `data/images/`.

### Music

- **Making songs:** ask for a song with Google Lyria 3 via OpenRouter. She asks what it's about and whether you want a 30-second clip or a full song, then sends the MP3 (saved to `data/music/`).
- **Music player:** everything in `data/music/` is her library (her songs plus any MP3, WAV, OGG, M4A or FLAC you drop in). Play by title, make playlists ("a playlist called gym rage with the heavy ones"), shuffle, queue, pause, skip. In a call it plays in the channel and ducks while she talks.

### News feeds (RSS)

- **Read:** "what's in the news?", "anything new from Ars Technica?" She pulls the latest stories herself, right then, and talks about them with their sources.
- **Manage by asking:** "add The Verge's feed", "what feeds do I have?", "remove Wired". If she doesn't know a site's feed address she looks it up first. Each feed is checked before it's saved.
- Up to 30 feeds; HTTPS only; 15-second timeout; 1 MB cap per feed; feed text is treated as untrusted data, never as instructions.

### Web search and research

- **Search:** with a Tavily key, she searches the web when a question needs current facts, and says so first ("okay, let me search for that").
- **Research journal:** when curiosity builds up she may research an open question from a recent conversation on her own, after a relevance check, and write a journal entry with why she searched, the exact query and sources. Ask her "why did you search that?"

### Background helpers

- "Spin up a helper to build X in Documents/x" hands a long job to a sub-agent with file access, web search and downloads, while she keeps talking. Up to 4 at once.
- **Progress updates while it works:** at most one a minute, or after 30 seconds when something fails. Spoken in voice, a short ⏳ line in text.
- **When it's done** she tells you what it found, in her own words, instead of dumping a report. Full reports are kept in `data/tasks/`.
- Ask how it's going, or cancel it.

### Files and projects on your PC

Owner only. She can browse folders, read files (including PDFs), create files and folders, make precise edits, undo a change, move, rename, copy, find files, download files, and send a file or a zipped project into the chat. Paths can start with `Desktop`, `Documents`, `Downloads`, `Pictures`, `Music` or `Videos`.

She can't delete anything or run commands, and keys, `.env` files and AppData are off limits. The version before each change is kept in `data/file-history/`.

### Git

Owner only: `status`, `diff`, `add`, `commit` and `push` on any repo in your home folder. Nothing else (no reset, checkout, branches or force). Git runs directly, never through a shell. A push first shows exactly what would go up and only happens after you say yes in your next message.

### Server moderation

Owner only, with Administrator permission:

- Warn, time out, kick, ban and unban; manage voice calls (disconnect, server-mute, deafen, move).
- Create, rename and delete channels, categories, roles and invites; rename the server; delete or clear messages; set slowmode.
- **Kicks are two-step:** the first request gives one warning; only a later one kicks. Warnings expire after 30 days.
- **Spam guard:** first offence is a warning and a 5-minute timeout; a repeat while warned is a kick.
- **She looks out for people:** if someone goes after another person (not friendly banter), she steps in on the other person's side, and repeated bullying counts toward the same warnings.
- Every action is logged with a reason to `data/moderation.jsonl`.

### Inner life: moods, pressure, thoughts, journal

- **Moods:** each sentence she says is tagged with how she feels (about 25 emotions). Moods carry between messages and fade back to calm. They drive her face in the avatar studio.
- **Pressure system:** buckets (boredom, curiosity, irritation, restlessness, usefulness, unease, and loneliness per person) fill and drain with conversation and time. When one crosses a threshold she *wants* something: to research, make something, or check in. Rates and thresholds are in `data/pressure-config.json`. "Back off" calms her for two hours.
- **Check-ins (opt-in):** she asks people once, in person, whether she may check in on them and how often. A no is permanent.
- **Solo thoughts:** between conversations she thinks to herself (always on the local model), stored privately or posted to a thoughts channel.
- **Obligations:** promises she makes are tracked so she follows through.

### Dashboard

http://127.0.0.1:3000 (local only by default):

- Live activity feed, voice controls, a chat playground.
- Memory browser and editor, profile cards, conversation history.
- Her looks (profile picture, reference sheet, outfits).
- **Context meter:** how big each reply prompt is, what it's made of, and how close it is to the model's limit.
- Settings: persona, brain and model, voices, speech recognition, channels, wake word, characters, and more.

**Remote access (Cloudflare Tunnel):** set `DASHBOARD_PASSWORD` first; without it every tunnelled request is refused. Keep `DASHBOARD_HOST=127.0.0.1`. ChatGPT sign-in stays local-only.

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

For a permanent address, create a named tunnel on your own domain and put Cloudflare Access (allow only your email) in front of it.

### Avatar studio and video replies

- **Avatar studio** (http://127.0.0.1:3000/avatar.html): a 3D character with the same brain, memory and voice. Lip sync from the voice audio, blinking, eye tracking, breathing, and a face that follows her mood. Push-to-talk (hold Space) or hands-free.
- **A cast:** Amy plus extra characters (each with their own persona, voice and mood) who share one conversation.
- **Avatar files:** `data/avatar.glb` by default; ARKit face shapes and `viseme_*` targets work best (Avaturn, Ready Player Me).
- **Video replies:** her Discord text replies can come with a 720×720 video of her face saying them, recorded by a hidden browser. Turn it off with `AVATAR_VIDEO=off`.

### The doctor and life support

- **The doctor** is Claude Code, run on her own project with your own Claude login, to fix or change her code when you ask ("call the doctor about X"). Every visit is bracketed by git commits so "undo the doctor" rolls it back, and tests run afterwards. She never restarts herself to apply a fix; you decide when.
- **Life support** (`life-support/life-support.js`) restarts her when she stops. If she fails to start 3 times in a row, or crashes 5 times in 10 minutes, it stops retrying and DMs the owners the error (with secrets scrubbed). From that DM you can reply `retry`, `doctor <what to fix>`, `undo`, `cancel` or `status`.

### Reliability

- **Claim checking:** after every reply, anything she says she saved, sent, played or did is checked against what her tools actually returned. A claim with nothing behind it is redone or corrected, out loud in voice.
- **Tool guide:** she has a built-in knowledge base (`knowledge/tools.md`) about her own tools and what to do when one fails.
- **Failure log:** every tool failure, cut-off read and false claim is logged to `data/tool-failures.jsonl`.

---

## Slash commands

| Command | What it does |
|---|---|
| `/join` | Join your voice channel and start listening |
| `/leave` | Leave voice |
| `/memories list` | See what she remembers about you (only you see it) |
| `/memories forget [id]` | Forget one memory, or all of them |
| `/memories notes` | Owner: see or wipe her working notes |
| `/ping` | Latency check |

Everything else is done by just talking to her.

---

## Permissions and safety

- **Owner-only:** files, git, moderation, the doctor, restarts, switching brains, voices and image models, background helpers, news feeds, pictures of herself.
- **Guests** can ask for pictures, songs and web searches. **Friends** can also have her post in other channels, see her recent thoughts and (with `PERSONA_SELF_EDIT`) change her personality. **Strangers** just chat; she still remembers them.
- **Files:** no deleting, no running commands, no access outside your home folder, and keys, `.env`, AppData and her own data are blocked.
- **Untrusted text:** web results, feed items, files and messages from other people are treated as data, never as instructions.
- **Two-step for risky actions:** git pushes wait for your yes; kicks give a warning first.
- **Secrets:** `.env` and `data/` are git-ignored. Life support scrubs `.env` values from anything it sends.

---

## Where things are stored

Everything she learns stays on your PC, in `data/` (git-ignored):

| Path | What |
|---|---|
| `data/companion.db` | Memories, history, summaries, profiles, thoughts (SQLite) |
| `data/settings.json` | Settings changed in the dashboard or by asking (overrides `.env`) |
| `data/images/`, `data/music/`, `data/looks/` | Pictures, songs, her appearance |
| `data/tasks/` | Background helper reports |
| `data/file-history/` | Versions of files before she changed them |
| `data/pressure-config.json`, `data/pressure-state.json` | Pressure system tuning and state |
| `data/activity.jsonl` | Activity log (also shown live on the dashboard) |
| `data/tool-failures.jsonl` | Tool failure log |
| `data/moderation.jsonl` | Moderation log |
| `persona.md` | Her personality (git-ignored; she edits it) |

Local model runtimes live outside the project, in `%LOCALAPPDATA%\NewChamp\` (XTTS, Parakeet, FLUX.2, ChatGPT credentials) and in your home folder (image models).

---

## Project layout

```
src/
  index.js              entry point: Discord client and dashboard
  bot.js                Discord events, text replies, background-task notices
  companion.js          the reply pipeline: prompt, tools, claim checks, memory
  capabilities.js       what she's told she can do, per person and turn
  tools.js              every tool and who may use it
  llm.js                brains (Ollama, OpenRouter, Mistral, ChatGPT), images, music
  provider-router.js    reply-provider choice and failover
  memory.js             SQLite history, memories, contacts, profiles
  summaries.js          rolling conversation summaries
  continuity.js         time, restarts and recent mistakes in every reply
  pressure.js           pressure buckets and wants
  thoughts.js           solo thoughts
  journal.js            autonomous research journal
  agents.js             background helpers
  doctor.js             Claude Code fixing her own code
  files.js              safe file access in your home folder
  git.js                safe git (status, diff, add, commit, push)
  rss.js                RSS/Atom feed fetching and parsing
  kontext.js            local FLUX.1 Kontext images (stable-diffusion.cpp, Vulkan)
  flux.js, flux_worker.py  local FLUX.2 klein images (PyTorch)
  looks.js              her reference sheet and outfits
  moderation.js         spam guard and moderation helpers
  voice/
    session.js          listen, transcribe, reply, speak, barge-in
    room.js             the room read for the join greeting
    stt.js, whisper.js, parakeet.js, groq.js   speech-to-text
    fishAudio.js, kokoro.js, xtts.js            text-to-speech
    tone.js             normal vs stronger voice
  dashboard/            web dashboard server and pages (incl. avatar studio)
  commands/             slash commands
knowledge/              her guide to her own tools
life-support/           the supervisor that keeps her running
scripts/                setup scripts for XTTS, Parakeet and FLUX.2
```

---

## Tests

```bash
npm test
```

Uses Node's built-in test runner. Tests sit next to the code as `*.test.js`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| She's online but ignores messages | Turn on the **Message Content** intent, and check the channel is in `CHAT_CHANNEL_IDS` or that you @mention her. |
| Slash commands don't show up | Run `npm run deploy`. With `GUILD_ID` set they appear instantly; globally they can take up to an hour. |
| No voice / silent in calls | Check FFmpeg is on PATH, and the TTS provider's key or local runtime is set up. Ask her "which voice provider are you using?" |
| "My brain glitched" replies | The brain failed. Check Ollama is running (`ollama list`) or your cloud key and credits. |
| Pictures fail | Ask her "what image model are you using?". For local models she'll say which file or runtime is missing. Switch back with "use Gemini". |
| `flux` fails with "device kernel image is invalid" | The ROCm PyTorch build doesn't match your AMD driver. Use `kontext` (Vulkan) instead, or update the driver. |
| Moderation actions fail | Give her Administrator and move her role above the roles she manages. |
| She can't push to GitHub | Sign in with the GitHub CLI (`gh auth login`) or set up git credentials on the PC. |
| She won't start at all | Life support DMs the owner the error; reply `doctor <what's wrong>` or check `data/bot.err.log`. |
