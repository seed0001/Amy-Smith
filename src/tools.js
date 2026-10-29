import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, ROOT, updateSettings } from './config.js';
import { AttachmentBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { generateImage, generateMusic, listModels, openRouterModels, rankModels } from './llm.js';
import { zip } from './zip.js';
import { rebuildMemories } from './extract.js';
import * as fs from './files.js';
import * as scratch from './scratchpad.js';
import * as git from './git.js';
import { fluxAvailability } from './flux.js';
import { kontextAvailability } from './kontext.js';
import * as rss from './rss.js';
import { recorderConnected, ensureRecorder, requestClip } from './avatarVideo.js';
import * as pressure from './pressure.js';
import * as thoughts from './thoughts.js';
import { todaysJournal, JOURNAL_DIR, recentResearchDecisions } from './journal.js';
import { logFailure } from './failures.js';
import { startTask, listTasks, cancelTask, runningHelpers, taskReport } from './agents.js';
import { MUSIC_DIR, tracks, findTrack, playlists, findPlaylist, savePlaylist, deletePlaylist, addSong } from './music.js';
import { activity, recentActivity } from './events.js';
import { findContact, listContacts, setContactTier, addObligation, openObligations, completeObligation, cancelObligation, personByRealName, reachCard, setReach } from './memory.js';
import { TIERS, isOwner, tierOf } from './contacts.js';
import { tierMoveRefusal, noteTierMove } from './relationships.js';
import { moderate, findMember } from './moderation.js';
import { callDoctor, doctorStatus, cancelDoctor, undoDoctor, lastVisit, visitResult } from './doctor.js';
import { requestRestart } from './restart.js';
import { markTesting } from './profiles.js';
import { NEGATIVE_WARN, NEGATIVE_KICK } from './standing.js';
import { profiles } from './memory.js';

import { presenceEvents } from './presence.js';
import { messagesBetween, oldestMessages, searchMessages, receivedFileRows } from './memory.js';
import { findReceived } from './attachments.js';
import * as looks from './looks.js';
import * as contextMeter from './context.js';
import { changeVoice } from './voice/provider.js';
import { setTone } from './voice/tone.js';
import { generateGeneralImage, generateSelfImage, imageRouteError } from './image-pipeline.js';
import { chatgptAuth } from './chatgpt-auth.js';
import { verifyChatGPTModel } from './chatgpt-provider.js';
import { loadXTTS, xttsSamples } from './voice/xtts.js';
import { providerRouter, activeReplyProvider, activeReplyModel } from './provider-router.js';
import { controlTurnClassifier } from './turn-routing.js';
import { isGenerationTool, createGenerationDispatcher } from './generation-jobs.js';
import { addMessage } from './memory.js';
import { systemInfo } from './system-info.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // Discord's upload limit for bots in most servers
const dispatchGeneration = createGenerationDispatcher({ startTask, runTool, completed: ({ name, ctx, task }) => {
  if (ctx.conversation) addMessage(ctx.conversation, { role: 'assistant', name: ctx.character?.main ? null : ctx.character?.name, content: `Generation task #${task.id} ${task.status}: ${task.result.slice(0, 1500)}`, tools: `${name} : ${task.status === 'done' ? 'ok' : 'failed'}` });
} });

// Tools the model can call mid-conversation. Each has an Ollama tool definition and a run(args, ctx) function.
// ctx says who's asking and where (see respond() in companion.js):
//   { perms, client?, guild?, sendHere(attachment)? }. perms comes from contacts.js and gates each tool.
const TOOLS = {
  web_search: {
    enabled: (ctx) => Boolean(config.tavily.apiKey && ctx.perms?.search),
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the internet. Use for current events, news, sports scores, weather, prices, release dates, or any fact you are unsure of or that may have changed recently. Do not use for casual chat.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for, phrased like a search engine query' },
            topic: { type: 'string', enum: ['general', 'news'], description: 'Use "news" for recent events and headlines' },
            time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only include results from this recent period' },
          },
          required: ['query'],
        },
      },
    },
    run: tavilySearch,
  },

  send_file: {
    enabled: (ctx) => Boolean(ctx.sendHere && ctx.perms?.files),
    definition: {
      type: 'function',
      function: {
        name: 'send_file',
        description:
          'Write a file (text, markdown, code, CSV, JSON, HTML, etc.) and send it as a Discord attachment. Use when someone asks you to write, make or send them a file or document. By default it goes to the current chat; set recipient to send it elsewhere.',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'File name with extension, e.g. "shopping-list.md" or "notes.txt"' },
            content: { type: 'string', description: 'The complete contents of the file' },
            recipient: {
              type: 'string',
              description:
                'Optional, friends only. A channel name like "#general" to post it in, or the name of a person who has DMed you before to DM it to them. Leave empty to send it right here.',
            },
            message: { type: 'string', description: 'Optional short note to go with the file when sending it elsewhere' },
          },
          required: ['filename', 'content'],
        },
      },
    },
    run: sendFile,
  },

  send_project: {
    enabled: (ctx) => Boolean(ctx.sendHere && ctx.perms?.files),
    definition: {
      type: 'function',
      function: {
        name: 'send_project',
        description:
          'Create a project made of several files (a website, an app, a script with its config, a story in chapters, etc.), bundle it into one .zip and send it as a Discord attachment. Use instead of send_file whenever there is more than one file. Write every file in full, with folders in the paths. By default it goes to the current chat; set recipient to send it elsewhere.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name, used for the .zip, e.g. "todo-app"' },
            files: {
              type: 'array',
              description: 'Every file in the project',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path inside the project, e.g. "index.html" or "src/app.js"' },
                  content: { type: 'string', description: 'The complete contents of the file' },
                },
                required: ['path', 'content'],
              },
            },
            recipient: {
              type: 'string',
              description:
                'Optional, friends only. A channel name like "#general" to post it in, or the name of a person who has DMed you before to DM it to them. Leave empty to send it right here.',
            },
            message: { type: 'string', description: 'Optional short note to go with it when sending it elsewhere' },
          },
          required: ['name', 'files'],
        },
      },
    },
    run: sendProject,
  },

  post_message: {
    enabled: (ctx) => Boolean(ctx.perms?.owner && ctx.client),
    definition: {
      type: 'function',
      function: {
        name: 'post_message',
        description:
          'Owner only, and only when your owner asks. Post an ordinary text message as yourself in a Discord text channel your owner names (in avatar mode, a video of you saying it is added to the post a moment later). To ping people, list them in `mention` and write "@Name" in the text where each ping goes (any not written in the text are put at the start). Never pings @everyone, @here or roles. Only say it was posted if this returns "Posted".',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'The channel: "#general", its name, or its ID' },
            text: { type: 'string', description: 'The message to post, up to 2000 characters' },
            mention: { type: 'array', items: { type: 'string' }, description: 'Members to ping: their names, @mentions or IDs' },
          },
          required: ['channel', 'text'],
        },
      },
    },
    run: postMessage,
  },

  generate_image: {
    enabled: (ctx) => Boolean(canMakeImages() && (ctx.sendHere || ctx.showImage) && ctx.perms?.files),
    definition: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Create a general or random picture from a description. This pipeline NEVER uses your saved appearance assets. For any picture of you, selfie, self-portrait or scene featuring you, call generate_self_image instead. General image requests must not call look or modify your appearance.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'A detailed description of the image: subject, setting, style, lighting, mood and composition',
            },
          },
          required: ['prompt'],
        },
      },
    },
    run: makeImage,
  },

  generate_self_image: {
    enabled: (ctx) => Boolean(canMakeImages() && ctx.perms?.owner && ctx.character?.main && ctx.perms?.files && (ctx.sendHere || ctx.showImage)),
    definition: {
      type: 'function',
      function: {
        name: 'generate_self_image',
        description: 'Create an image OF YOU using your existing saved identity reference sheet and current look. Use for selfies, portraits, drawings of yourself or scenes featuring you in any style. This separate pipeline requires existing identity assets; it never invents a new identity or changes your profile picture. Use generate_image for ordinary subjects. Use look only to explicitly manage your identity, wardrobe or saved looks.',
        parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Requested scene, pose, clothing, style and composition featuring the companion' } }, required: ['prompt'] },
      },
    },
    run: makeSelfImage,
  },

  look: {
    enabled: (ctx) =>
      Boolean(
        config.openrouter.apiKey &&
          ctx.perms?.owner &&
          ctx.character?.main &&
          ctx.perms?.files &&
          (ctx.sendHere || ctx.showImage),
      ),
    definition: {
      type: 'function',
      function: {
        name: 'look',
        description:
          'Manage her stored appearance and wardrobe. Actions: "setup" explicitly creates/replaces identity assets; "new" creates a new outfit from her reference sheet and CHANGES the active profile picture; "wear" activates an existing saved look; "send" resends a saved look; "list" lists saved looks; "reference" shows the identity sheet. Use only for explicit appearance/wardrobe management. Requests for a new selfie, portrait or image of her MUST use generate_self_image instead. Never replace identity assets to fulfill an ordinary self-image request.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['setup', 'new', 'wear', 'send', 'list', 'reference'],
              description: 'setup = first-time identity sheet and profile; new = make a new look; wear = switch profile to a saved look; send = resend a look; list = show saved looks; reference = show the identity sheet',
            },
            description: {
              type: 'string',
              description:
                'For setup: the appearance she is inventing (face, hair, body, skin tone, everyday style); empty means invent one from her persona. For new: exactly what she is wearing, plus the setting, pose and mood',
            },
            name: { type: 'string', description: 'A short name for a new look, e.g. "cozy sweater" or "summer dress"' },
            look: { type: 'string', description: 'For wear/send: a saved look id or name; empty means the active look' },
            recipient: {
              type: 'string',
              description: 'For send/reference: "" for here, a "#channel" name, or a person who has DMed you; friends and owner only for elsewhere',
            },
            message: { type: 'string', description: 'Optional short note to go with a look sent elsewhere' },
          },
          required: ['action'],
        },
      },
    },
    run: lookTool,
  },

  generate_music: {
    enabled: (ctx) => Boolean(config.openrouter.apiKey && (ctx.sendHere || ctx.showAudio) && ctx.perms?.files),
    definition: {
      type: 'function',
      function: {
        name: 'generate_music',
        description:
          'Make a song or a piece of music and share it in this chat. Only use once you know what it should be about (topic, mood, genre or style) and how long it should be (a 30-second clip or a full song). If either is missing, ask instead of calling this.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'A detailed description for the music model: genre, mood, tempo, instruments, vocals or instrumental, what the song is about, and any lyrics or themes they asked for',
            },
            length: { type: 'string', enum: ['clip', 'full'], description: '"clip" for a 30-second clip, "full" for a full-length song with verses and chorus' },
            title: { type: 'string', description: 'A short song title, used to find and play it later' },
          },
          required: ['prompt', 'length'],
        },
      },
    },
    run: makeMusic,
  },

  music: {
    enabled: (ctx) => Boolean(ctx.perms?.files && (ctx.voice || ctx.studioMusic || ctx.sendHere)),
    // A getter so the track and playlist lists are current each time the tool is offered.
    get definition() {
      const list = tracks();
      const lists = Object.keys(playlists());
      return {
        type: 'function',
        function: {
          name: 'music',
          description:
            'Play and manage the music library: songs you made plus any your owner added. Play tracks by title, play or save playlists, queue, pause, resume, skip, stop, or say what is playing. ' +
            'To build a playlist from a description ("something chill", "all the rock ones"), pick matching titles from the library below yourself. ' +
            `Library (${list.length}): ${list.map((t) => `"${t.title}"${t.about ? ` (${t.about.slice(0, 80)})` : ''}`).join('; ') || 'empty'}. ` +
            `Playlists: ${lists.map((n) => `"${n}"`).join(', ') || 'none yet'}.`,
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['play', 'queue', 'pause', 'resume', 'skip', 'stop', 'now_playing', 'save_playlist', 'delete_playlist', 'list'],
                description: 'play replaces what is playing; queue adds to the end; save_playlist stores tracks under a name without playing',
              },
              tracks: { type: 'array', items: { type: 'string' }, description: 'Track titles from the library, in order' },
              playlist: { type: 'string', description: 'A playlist name: to play, delete, or save the given tracks under' },
              shuffle: { type: 'boolean', description: 'Shuffle the order' },
            },
            required: ['action'],
          },
        },
      };
    },
    run: musicControl,
  },

  // Her working notes. Writing is its own tool with the content fields required: some providers
  // drop every optional argument, which left notes with no text when it was one "action" tool.
  note: {
    enabled: (ctx) => Boolean(ctx.conversation),
    definition: {
      type: 'function',
      function: {
        name: 'note',
        description:
          "Write a note on your private scratchpad for this conversation; you'll see it at the start of every turn. Kinds: mood = how someone is doing and why; thread = a topic in progress; commitment = something you promised to do; open_question = something left unanswered; callback = something to bring back up later. Notes stay private unless you choose to mention them.",
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: scratch.KINDS },
            text: { type: 'string', description: 'One to three short sentences' },
            people: { type: 'array', items: { type: 'string' }, description: 'Names of who it is about' },
            expires_in_hours: { type: 'number', description: 'Optional: drop the note on its own after this many hours' },
          },
          required: ['kind', 'text', 'people'],
        },
      },
    },
    run: writeNote,
  },

  scratchpad: {
    enabled: (ctx) => Boolean(ctx.conversation),
    definition: {
      type: 'function',
      function: {
        name: 'scratchpad',
        description: 'Change a note on your scratchpad: update its text when things change, resolve it once it is settled (it disappears), or list the notes.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['update', 'resolve', 'list'] },
            id: { type: 'number', description: 'The note number (for update or resolve)' },
            text: { type: 'string', description: 'For update: the new text' },
          },
          required: ['action', 'id'],
        },
      },
    },
    run: scratchpadAction,
  },

  thread: {
    enabled: (ctx) => Boolean(ctx.conversation),
    definition: {
      type: 'function',
      function: {
        name: 'thread',
        description:
          `Start or update one of your active threads: at most ${scratch.MAX_THREADS} ongoing situations you follow across every conversation and channel (e.g. "Brandon / Katie living situation"). Using an existing label overwrites its state (current status only, no history). With ${scratch.MAX_THREADS} open, retire one first.`,
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A short name for the situation' },
            state: { type: 'string', description: 'Its current status, one or two sentences' },
            people: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'state', 'people'],
        },
      },
    },
    run: setThreadAction,
  },

  threads: {
    enabled: (ctx) => Boolean(ctx.conversation),
    definition: {
      type: 'function',
      function: {
        name: 'threads',
        description: 'Retire an active thread that is over, or list them.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['retire', 'list'] },
            id: { type: 'number', description: 'For retire: the thread number' },
          },
          required: ['action', 'id'],
        },
      },
    },
    run: threadAction,
  },

  guide: {
    enabled: () => true,
    definition: {
      type: 'function',
      function: {
        name: 'guide',
        description:
          'Your knowledge base about your own tools: what each does, how to fill in its fields, and what to do when it fails. Look up a tool by name (e.g. "files", "git") or a problem ("error", "not available", "truncated", "voice"). Use it when a tool returns an error or you are unsure how to use one, before guessing.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'A tool name or a problem; "" to list the topics' },
          },
          required: ['topic'],
        },
      },
    },
    run: guideLookup,
  },

  checkin_consent: {
    enabled: (ctx) => Boolean(ctx.speaker?.id && ctx.speaker.id !== 'dashboard'),
    definition: {
      type: 'function',
      function: {
        name: 'checkin_consent',
        description:
          "Record whether the person talking to you is okay with you checking in on them on your own now and then (their profile card). Use when they answer your question about it, change their mind, or tell you not to message them. Saves their answer, how often is okay, and what they'd like to talk about or what's too much. A no is permanent: you never ask again.",
        parameters: {
          type: 'object',
          properties: {
            answer: { type: 'string', enum: ['yes', 'no'] },
            every_days: { type: 'number', description: 'For yes: how often is okay, in days (7 = once a week)' },
            note: { type: 'string', description: 'What they want to talk about, tone, or what would be too much' },
            person: { type: 'string', description: 'Owner only: someone else this is for' },
          },
          required: ['answer'],
        },
      },
    },
    run: consentAction,
  },

  obligations: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'obligations',
        description:
          'Owner only. Your to-do list of obligations: things you must do until they are checked off. Add one when your owner asks you to do something later, especially when a person shows up ("when UltraLogic joins, tell him about X", "remind me to ask Chris for the files when he is on"); those fire automatically the next time that person joins voice or talks to you, and are checked off once you have done them. One without a person is a standing priority; check it off with done when it is finished. Also list, or cancel one.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list', 'done', 'cancel'] },
            task: { type: 'string', description: 'For add: what you have to do, written so you will understand it later (include what to tell them, and who asked)' },
            person: { type: 'string', description: 'For add: who it is waiting on, by name, if it should happen when they show up' },
            id: { type: 'number', description: 'For done or cancel: the obligation number' },
            note: { type: 'string', description: 'For done: how it was fulfilled' },
          },
          required: ['action'],
        },
      },
    },
    run: obligationAction,
  },

  files: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'files',
        description:
          "Owner only. Work with files and folders on your owner's computer: list a folder, read a file (with line numbers), create a file, make a precise edit, undo the last change, make a folder, " +
          'move or rename a file OR A WHOLE FOLDER, copy a file OR A WHOLE FOLDER (everything inside it, any size; e.g. copy "Desktop/new champ" to "Desktop/new champ backup"), find a file by name, or send a file into this chat. ' +
          'Paths can start with Desktop, Documents, Downloads, Pictures, Music, Videos or ~ (home). You cannot delete anything or run commands. ' +
          'Background helpers can also download a file from an https url into path (a folder or the file name); it says plainly whether every byte arrived, with the size and SHA-256. Only report a download as done when it says "Downloaded". ' +
          'To change a file, read it first, then use edit with old_text copied exactly from it (a few lines, enough to be unique) and the new_text to put in its place. Use write with overwrite only to replace a whole file.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'read', 'write', 'edit', 'undo', 'mkdir', 'move', 'copy', 'find', 'send', 'download'] },
            url: { type: 'string', description: 'For download (helpers only): the https:// address of the file' },
            path: { type: 'string', description: 'The file or folder to act on, always given in full, e.g. "Desktop/my-app" or "Desktop/my-app/src/index.js". For find, the folder to search in.' },
            to: { type: 'string', description: 'Destination for move or copy (a new name, or an existing folder to put it in). Works for whole folders too.' },
            content: { type: 'string', description: 'Full file contents, for write' },
            overwrite: { type: 'boolean', description: 'For write: replace an existing file (its old version is kept for undo)' },
            old_text: { type: 'string', description: 'For edit: the exact existing text to replace' },
            new_text: { type: 'string', description: 'For edit: the text to put in its place' },
            replace_all: { type: 'boolean', description: 'For edit: replace every occurrence' },
            start_line: { type: 'number', description: 'For read: first line to show' },
            end_line: { type: 'number', description: 'For read: last line to show' },
            depth: { type: 'number', description: 'For list: how many folder levels to show (default 1, max 4)' },
            name: { type: 'string', description: 'For find: part of the file name' },
          },
          // path is required: some providers drop optional arguments, and a missing path used to
          // fall back to listing the Desktop, so every "open that folder" showed the Desktop again.
          required: ['action', 'path'],
        },
      },
    },
    run: fileAction,
  },

  self: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'self',
        description:
          'Owner only. Look at yourself as a running program. "map" tells you where everything about you lives: persona file, settings, database (memories, history, notes, obligations), code, logs, and what your current brain and settings are. "context" shows how much of your context window the last reply prompt used and what it was made of (system prompt sections, raw history, current message, tool schemas, summaries, memories), how it has grown over recent turns, and the limits: the model context window, the raw history cap, and when messages are summarized. "journal" shows the journal entries from today. "mood" shows your pressure buckets (boredom, curiosity, irritation, restlessness, usefulness, unease, loneliness per person). "thoughts" shows your recent solo thoughts. "logs" searches your live activity log (the last few hundred events since the bot started): errors, tool calls with timings, what was heard and replied. Use these before stating any cause about how you work.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['map', 'logs', 'mood', 'journal', 'research', 'thoughts', 'context'], description: 'research shows why autonomous searches were selected or skipped, the exact queries, source context, and current candidate rejections; journal shows written entries' },
            type: { type: 'string', description: 'For logs: only this kind of event, e.g. "error", "tool-call", "heard", "replied", "plan"' },
            search: { type: 'string', description: 'For logs: only events containing this text' },
            last: { type: 'number', description: 'For logs: how many of the newest matches (default 30). For context: how many recent turns to list (default 8, max 20)' },
          },
          required: ['action'],
        },
      },
    },
    run: selfInspect,
  },

  system_info: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'system_info',
        description:
          "Owner only. Read-only look at your owner's computer. \"hardware\": CPU, RAM, graphics cards with their video memory (VRAM), disks with free space, Windows version. \"status\": how it's doing right now: uptime, CPU load, memory in use, disk space, video memory in use, and your own process. \"processes\": running programs by memory or CPU time, names and IDs only. " +
          'Use it before saying what the computer can run (e.g. which local image or language model fits the GPU), or when asked about hardware, specs, performance or what is running. It cannot change, start or stop anything.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['hardware', 'status', 'processes'] },
            name: { type: 'string', description: 'For processes: only programs with this in their name, e.g. "python" or "ollama"' },
            sort: { type: 'string', enum: ['memory', 'cpu'], description: 'For processes: order by memory (default) or total CPU time' },
            limit: { type: 'number', description: 'For processes: how many to show (default 15, max 40)' },
          },
          required: ['action'],
        },
      },
    },
    run: (args) => systemInfo(args),
  },

  avatar_mode: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'avatar_mode',
        description:
          'Owner only. Turn avatar mode (video replies) on or off: when on, your Discord text replies also get a short video of your face saying them. Or check whether it is on.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['on', 'off', 'status'] },
          },
          required: ['action'],
        },
      },
    },
    run: avatarMode,
  },

  inner_monologue: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'inner_monologue',
        description: 'Owner only. Turn your inner monologue on or off (thinking out loud before you answer, said and shown), or check whether it is on.',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['on', 'off', 'status'] } },
          required: ['action'],
        },
      },
    },
    run: async ({ action }) => {
      if (action === 'on' || action === 'off') {
        updateSettings({ innerMonologue: action === 'on' });
        activity('settings', { message: `Inner monologue turned ${action}` });
      }
      return `Inner monologue is ${config.innerMonologue ? 'on: you think out loud before each reply, starting with your next one' : 'off: you just answer, starting with your next reply'}.`;
    },
  },

  turn_classifier: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'turn_classifier',
        description: 'Owner only. Turn the preliminary turn-classification/planning pass on or off, or check its status. Use for "turn classification off", "skip the classifier", "let the main model pick its tools", "turn classification back on", or "is the classification pass on?". Off bypasses only that preliminary model request, preserving tools and permissions. The control remains available when off. Actually call it before confirming a change.',
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status'] } }, required: ['action'] },
      },
    },
    run: (args) => controlTurnClassifier(args, { config, updateSettings, activity }),
  },

  solo_monologue: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'solo_monologue',
        description:
          'Owner only. Turn your solo thoughts (private thinking between messages, separate from your per-reply inner monologue) on or off, check their status, choose the one text channel they may post in, or clear that channel so they stay private. Channel can be #name, name, a channel ID, or "here".',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['on', 'off', 'status', 'set_channel', 'clear'] },
            channel: { type: 'string', description: 'For set_channel: #name, name, a channel ID, or "here". Empty means here.' },
          },
          required: ['action'],
        },
      },
    },
    run: soloMonologue,
  },

  recent_thoughts: {
    enabled: (ctx) => Boolean(ctx.perms?.owner || ctx.perms?.tier === 'friend'),
    definition: {
      type: 'function',
      function: {
        name: 'recent_thoughts',
        description:
          'Look at your own recent solo thoughts: what you have been thinking about between conversations. Owner sees all of them; friends see the ones you chose to post. Use it when someone asks what you have been thinking about or what is on your mind.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'How many thoughts (default 5, max 10)' },
            query: { type: 'string', description: 'Only thoughts whose topic or text contains this' },
          },
        },
      },
    },
    run: recentThoughts,
  },

  news_feeds: {
    enabled: (ctx) => Boolean(config.rss.enabled && ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'news_feeds',
        description:
          'Owner only. Your RSS/Atom news feeds, done yourself right now (never hand this to a background helper). read pulls the latest headlines from all feeds (or one, by `feed` name) and you talk about what is new; list shows the feeds; add saves one (`url`, optional `name`); remove deletes one by name or url. ' +
          'If there are no feeds yet, say so and offer to add some; you can find a site\'s feed address with web_search first. Talk about the stories conversationally, with their sources; don\'t paste the list.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'list', 'add', 'remove'] },
            feed: { type: 'string', description: 'For read: one feed name to pull ("" for all). For remove: the name or url.' },
            url: { type: 'string', description: 'For add: the feed address (https)' },
            name: { type: 'string', description: 'For add: a short name like "The Verge" ("" uses the site name)' },
            count: { type: 'number', description: 'For read: how many recent stories in total (0 = 15)' },
          },
          required: ['action', 'feed', 'url', 'name', 'count'],
        },
      },
    },
    run: newsFeeds,
  },

  image_model: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'image_model',
        description:
          "Owner only. Choose which model makes your pictures, from plain words: 'use Kontext', 'use the local model' or 'make images on my GPU' means kontext (FLUX.1 Kontext on this PC, free, private, keeps your face from your reference); 'use Flux 2' or 'use klein' means flux (FLUX.2 klein, local); 'use Gemini', 'go back to the cloud' or naming any OpenRouter image model (e.g. 'use GPT image', 'openai/gpt-5-image') means openrouter with that model. " +
          'status shows what you use now; list shows the choices. Actually call set before saying it changed; if it returns an error, say what is missing.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'list', 'set'] },
            provider: { type: 'string', enum: ['', 'kontext', 'flux', 'openrouter'], description: 'For set: kontext (local, default local choice), flux (local FLUX.2 klein) or openrouter (cloud).' },
            model: { type: 'string', description: 'For set with openrouter: the image model id or the words your owner used ("gemini", "gpt image"); "" keeps the current one.' },
          },
          required: ['action', 'provider', 'model'],
        },
      },
    },
    run: imageModel,
  },

  voice_engine: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'voice_engine',
        description:
          "Owner only. Change your TTS provider naturally: 'use XTTS' or 'use my local voice sample' means engine xtts (local voice cloning); 'use Kokoro' means kokoro; 'switch back to Fish Audio' means fish. XTTS uses audio already saved in its sample folder. Pick a Kokoro preset or XTTS sample filename with voice, adjust speed, list providers/voices, or check status. Actually call the tool before confirming. Never switch to XTTS if the sample/runtime is missing.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'set', 'voices', 'providers'] },
            engine: { type: 'string', enum: ['', 'fish', 'kokoro', 'xtts'], description: 'The engine to switch to, or engine whose voices to list (empty keeps the current one).' },
            voice: { type: 'string', description: 'A Kokoro preset (af_heart, bf_emma) or an XTTS sample filename (reference.wav). Empty keeps it.' },
            speed: { type: 'number', description: 'Kokoro or XTTS speed, 0.5 to 2 (1 normal; 0 keeps it).' },
          },
          required: ['action'],
        },
      },
    },
    run: voiceEngine,
  },

  voice_tone: {
    enabled: (ctx) => Boolean(ctx.voice?.conversation && ctx.character?.main !== false),
    definition: {
      type: 'function',
      function: {
        name: 'voice_tone',
        description:
          "Choose between your normal voice and your stronger, more powerful voice in this voice call. Use strong only for a genuinely serious situation (safety, a real emergency, setting a firm boundary) or frustration that has lasted several messages, never for one sharp remark, a joke or ordinary disagreement; give the reason. Go back to normal once things have calmed down. Switches are held for a few minutes and strong wears off by itself. When your owner tells you to use a voice, set override true; owner says to let you choose again means auto. status shows which voice you're using.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'strong', 'normal', 'auto'] },
            reason: { type: 'string', description: 'For strong: why, in a few words. Otherwise "".' },
            override: { type: 'boolean', description: 'True only when your owner explicitly told you which voice to use.' },
          },
          required: ['action'],
        },
      },
    },
    run: (args, ctx) => setTone(ctx.voice.conversation, args, { config, owner: Boolean(ctx.perms?.owner), activity }),
  },

  timeline: {
    enabled: (ctx) => Boolean(ctx.perms?.remember),
    definition: {
      type: 'function',
      function: {
        name: 'timeline',
        description:
          'Look back through this conversation by time; every message is timestamped. Use it for "what were we talking about before X joined", "what did we say earlier / an hour ago / at 3pm", "what is the oldest thing you remember", or to find when something was said. ' +
          'action: before_join (what was said in the minutes before `person` last joined voice), joins (when people joined and left the call), around (`time`: "3:15 pm", "45 minutes ago", "yesterday 9pm"), search (`text`), oldest. Fill every field; use "" for ones you do not need and 0 for minutes.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['before_join', 'joins', 'around', 'search', 'oldest'] },
            person: { type: 'string', description: 'For before_join and joins: who (a name).' },
            time: { type: 'string', description: 'For around: when, e.g. "3:15 pm", "45 minutes ago", "2 hours ago", "yesterday 9pm".' },
            text: { type: 'string', description: 'For search: words to look for.' },
            minutes: { type: 'number', description: 'How many minutes of conversation to pull (default 15).' },
          },
          required: ['action', 'person', 'time', 'text', 'minutes'],
        },
      },
    },
    run: timelineLookup,
  },

  received_file: {
    enabled: (ctx) => Boolean(ctx.conversation && ctx.speaker),
    definition: {
      type: 'function',
      function: {
        name: 'received_file',
        description:
          'Read again a document someone sent you on Discord (in any channel, even while you are in voice), from what was taken out of it when it arrived. Use it before answering anything about what a sent file says, whenever its text is not in this message. ' +
          'name: the file name or words of its title ("heavy water manual"); "" lists the files you can open. part: 1 for the start; a long document comes in parts. Only say you read it if this returns ok.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name or words of its title; "" to list them' },
            part: { type: 'number', description: 'Which part of a long document (1 = the start)' },
          },
          required: ['name', 'part'],
        },
      },
    },
    run: receivedFile,
  },

  moderate: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'moderate',
        description:
          "Owner only. Manage the Discord server. Members: warn, kick, ban, unban, timeout / untimeout (`minutes`), add_role / remove_role (`role`). Kicks are two-step: the first kick request gives that member one warning (by DM, or in the channel if their DMs are closed); only a later kick, with that warning on record, actually removes them. Set `force` true only when your owner explicitly says to kick right now with no warning. " +
          'Channels: create_channel (`name`, `type` text/voice/category/forum/announcement/stage, `category` to nest it, `topic`), edit_channel (`channel`, `name`, `topic`), delete_channel (`channel`; refuses the channel you are talking in unless `force`), list_channels. ' +
          'Voice calls: voice_disconnect (remove `user` from their call), voice_mute / voice_unmute (server mute: nobody can hear them), voice_deafen / voice_undeafen, voice_move (`user` to the voice `channel`). ' +
          'Roles: create_role (`name`, `color` as hex like "#ff8800", `hoist`, `mentionable`), delete_role (`role`). ' +
          'Also slowmode (`minutes` between messages, 0 turns it off), delete_message (`message_id`), clear (last `count` messages in `channel`, optionally only from `user`), create_invite (`channel`), edit_server (`name`), server_info, warnings (active warnings), log (recent actions). ' +
          'Every action happens immediately and is logged with the reason. Fill every field; use "" or 0 or false for ones you do not need. `channel` "" means the current channel.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['warn', 'warnings', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'delete_message', 'clear', 'slowmode', 'add_role', 'remove_role', 'voice_disconnect', 'voice_mute', 'voice_unmute', 'voice_deafen', 'voice_undeafen', 'voice_move', 'create_channel', 'edit_channel', 'delete_channel', 'list_channels', 'create_role', 'delete_role', 'create_invite', 'edit_server', 'server_info', 'log'] },
            user: { type: 'string', description: 'Who: their name or @mention.' },
            channel: { type: 'string', description: 'Channel name ("" for the current one). For voice_move: the voice channel to move them to.' },
            role: { type: 'string', description: 'For add_role / remove_role / delete_role: the role name.' },
            minutes: { type: 'number', description: 'For timeout: how long. For slowmode: minutes between messages (0.5 = 30 seconds, 0 = off).' },
            count: { type: 'number', description: 'For clear / delete_message: how many messages (max 100). For log: how many entries.' },
            reason: { type: 'string', description: 'Why (goes in the log and the Discord audit log). Required for warn, kick and ban.' },
            message_id: { type: 'string', description: 'For delete_message: a specific message ID, or "".' },
            name: { type: 'string', description: 'For create_channel / edit_channel: the channel name. For create_role: the role name. For edit_server: the new server name.' },
            type: { type: 'string', enum: ['text', 'voice', 'category', 'forum', 'announcement', 'stage'], description: 'For create_channel: what kind of channel (default text).' },
            category: { type: 'string', description: 'For create_channel: the category to put it under, or "".' },
            topic: { type: 'string', description: 'For create_channel / edit_channel: the channel topic, or "".' },
            color: { type: 'string', description: 'For create_role: hex color like "#ff8800", or "" for none.' },
            hoist: { type: 'boolean', description: 'For create_role: show separately at the top of the member list.' },
            mentionable: { type: 'boolean', description: 'For create_role: let people @mention the role.' },
            force: { type: 'boolean', description: 'Skip the warning and kick now, or delete the current channel. Only when your owner explicitly insists.' },
          },
          required: ['action', 'user', 'channel', 'role', 'minutes', 'count', 'reason', 'message_id'],
        },
      },
    },
    run: (args, ctx) => moderate(args, ctx),
  },

  git: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'git',
        description:
          "Owner only. Git and GitHub for your owner's projects, signed in as your owner's GitHub account: status, diff, add (stage files), commit, push, pull; " +
          'repos (list their GitHub repositories), clone (a GitHub repo onto the Desktop), create_repo (a new GitHub repo, private unless they ask for public; give `repo` a local project to link it as origin), prs / create_pr, issues / create_issue. No other git commands exist. ' +
          'Push is two steps: calling push first shows what would be pushed; tell your owner and ask them to confirm. Only after they say yes in their next message, call push again and it goes through. Never say something was pushed unless push returned "Pushed".',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'diff', 'add', 'commit', 'push', 'pull', 'repos', 'clone', 'create_repo', 'prs', 'create_pr', 'issues', 'create_issue'] },
            repo: { type: 'string', description: 'The project folder (or any path inside it), e.g. "Desktop/lyra-video-game". For repos: "". For clone: "" (goes to Desktop/<name>) or a folder to clone into. For create_repo: "" or a local project to link.' },
            name: { type: 'string', description: 'For clone and create_repo: the GitHub repository, "name" or "owner/name"' },
            title: { type: 'string', description: 'For create_pr and create_issue' },
            body: { type: 'string', description: 'For create_pr and create_issue; for create_repo, its description' },
            public: { type: 'boolean', description: 'For create_repo: make it public (default private)' },
            files: { type: 'array', items: { type: 'string' }, description: 'For add: files to stage, relative to the project, or ["all"]. For diff: optionally one file.' },
            staged: { type: 'boolean', description: 'For diff: show what is staged instead of unstaged changes' },
            message: { type: 'string', description: 'For commit: the commit message' },
          },
          required: ['action', 'repo'],
        },
      },
    },
    run: gitAction,
  },

  list_models: {
    enabled: (ctx) => Boolean(ctx.perms?.owner && config.openrouter.apiKey),
    definition: {
      type: 'function',
      function: {
        name: 'list_models',
        description:
          'Owner only. Get OpenRouter models as a numbered list, so your owner can pick one by number ("go with 2"). Either the best few for a kind of work (purpose), or a search of the whole catalog by name or maker (search, e.g. "grok", "xai", "claude", "qwen coder"). Present them as 1, 2, 3 with a few words each and the price.',
        parameters: {
          type: 'object',
          properties: {
            purpose: { type: 'string', enum: ['coding', 'reasoning', 'general', 'cheap'], description: 'What the model is for (used when search is empty)' },
            search: { type: 'string', description: 'Words to find in model names or makers, searching every model; "" to rank by purpose instead' },
            count: { type: 'number', description: 'How many to list (default 5 ranked, up to 15 for a search)' },
          },
          // Every field is required: some providers drop optional ones, which silently lost the search.
          required: ['purpose', 'search', 'count'],
        },
      },
    },
    run: showModels,
  },

  doctor: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'doctor',
        description: "Owner only, and only when your owner asks. Call the doctor (Claude Code, on your owner's own Claude login) to fix or adjust your own code: something broken, an error, or a change to how you work. It runs in the background for a few minutes and reports back; it saves a snapshot first, runs the tests after, and never restarts you. call: describe the problem or change in `task` as fully as you can (what happened, when, any error you saw). status: is it working. cancel: stop it. undo: roll back its last visit.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['call', 'status', 'cancel', 'undo'] },
            task: { type: 'string', description: 'For call: what to fix or change, in detail. "" otherwise.' },
          },
          required: ['action', 'task'],
        },
      },
    },
    // The report goes into her history with its real outcome, like generation results do.
    run: ({ action, task }, ctx) => action === 'call' ? callDoctor(task, async (text) => {
      if (ctx.conversation && lastVisit()) addMessage(ctx.conversation, { role: 'assistant', name: ctx.character?.main ? null : ctx.character?.name, content: text.slice(0, 1500), tools: visitResult(lastVisit()) });
      await ctx.notify?.(text);
    })
      : action === 'cancel' ? cancelDoctor() : action === 'undo' ? undoDoctor() : doctorStatus(),
  },

  restart: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'restart',
        description: "Owner only, and only when your owner explicitly tells you to restart (usually after a doctor visit, so the fix takes effect). You finish your reply, restart, rejoin this voice channel, and say a line about how you're doing. Never restart on your own, and never because someone else asked.",
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string', description: 'Why, in a few words (e.g. "apply the doctor\'s fix").' } },
          required: ['reason'],
        },
      },
    },
    run: ({ reason }, ctx) => requestRestart({ reason, guild: ctx.guild, channel: ctx.channel, by: { id: ctx.speaker?.id, name: ctx.speaker?.name } }),
  },

  standing_test: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'standing_test',
        description: "Owner only. Testing mode for good and bad marks: turns off the spacing between marks for a while, so every kind or rude moment counts (normally one kind mark per 4 hours, one bad mark per 10 minutes, per person). Also reports everyone's current marks. Use when your owner wants to test the marks system, or asks to see the marks.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['on', 'off', 'status'], description: 'on: start testing mode, off: end it, status: just report' },
            minutes: { type: 'number', description: 'For on: how long testing mode lasts (default 30, max 240).' },
          },
          required: ['action', 'minutes'],
        },
      },
    },
    run: standingTest,
  },

  openrouter_balance: {
    enabled: (ctx) => Boolean(ctx.perms?.owner && config.openrouter.apiKey),
    definition: {
      type: 'function',
      function: {
        name: 'openrouter_balance',
        description: "Owner only. Check your owner's OpenRouter balance: credits bought, spent, and what's left. Say the remaining amount in dollars plainly (in voice, round to cents and say it naturally).",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    run: openRouterBalance,
  },

  background_task: {
    enabled: (ctx) => Boolean(ctx.perms?.owner && config.openrouter.apiKey),
    definition: {
      type: 'function',
      function: {
        name: 'background_task',
        description:
          "Owner only. Use for lengthy writing, project building, research or fixes: hand the complete brief to a sub-agent with file access, web search, send_file and send_project while you keep talking. Ask the helper to deliver requested files here. Also check running jobs (including image/music generation) or cancel one by ID. Status with an ID reads that task's whole report, even after a restart. Include the goal, paths and what done looks like.",
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'status', 'cancel'] },
            title: { type: 'string', description: 'For start: a short name for the task' },
            instructions: { type: 'string', description: 'For start: the full brief for the helper' },
            model: { type: 'string', description: 'For start: optional OpenRouter model id for the helper; defaults to your current model' },
            id: { type: 'number', description: 'For cancel: the task number. For status: read that task\'s whole report' },
            start: { type: 'number', description: 'For status with id: character to start from, to read the rest of a report that came back TRUNCATED' },
          },
          required: ['action'],
        },
      },
    },
    run: backgroundTask,
  },

  switch_brain: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'switch_brain',
        description:
          'Owner only. Change your reply provider: ollama (local), openrouter (cloud API models), or chatgpt (the owner’s connected ChatGPT subscription). ChatGPT must first be connected in dashboard Settings → Brain; never use Codex or request passwords/tokens. Can select a model and OpenRouter reasoning.',
        parameters: {
          type: 'object',
          properties: {
            brain: { type: 'string', enum: ['ollama', 'openrouter', 'chatgpt'], description: 'Which provider to use' },
            model: { type: 'string', description: 'The model to switch to, as said, e.g. "grok 4.20", "kimi", "gpt-6.1-sol" or an exact id; "" to keep the current one' },
            pick: { type: 'number', description: 'A number from the model list you just showed (list_models), e.g. 2; 0 if not picking from a list' },
            reasoning: { type: 'string', enum: ['none', 'low', 'medium', 'high'], description: 'Optional, OpenRouter only: how hard it thinks before answering' },
          },
          // model and pick are required (empty / 0 when unused): some providers drop optional fields,
          // which once turned "switch to grok 4.20" into a switch that kept the old model.
          required: ['brain', 'model', 'pick'],
        },
      },
    },
    run: switchBrain,
  },

  rebuild_memories: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'rebuild_memories',
        description:
          "Owner only. Read back through the saved conversation history and pull out long-term memories about everyone in it, filed under the right person. Use when your owner asks you to go through the chat history or logs and (re)build, repopulate or refresh your memories. Set fresh only if they also ask to wipe or clear the existing memories first.",
        parameters: {
          type: 'object',
          properties: {
            fresh: { type: 'boolean', description: 'Delete all existing memories first. Only when the owner explicitly asks to clear or wipe them.' },
            this_conversation_only: { type: 'boolean', description: 'Only read the current conversation instead of all of them' },
          },
        },
      },
    },
    run: startRebuild,
  },

  read_source: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    // A getter so the file list is current each time the tool is offered.
    get definition() {
      return {
        type: 'function',
        function: {
          name: 'read_source',
          description:
            'Owner only. Read your own source code: the program that runs you (Discord bot, memory, voice, tools, avatar studio). ' +
            'Use when your owner asks how you work, about your code, or wants you to explain, review or suggest changes to it. ' +
            `Read every file you need in one call. Your files: ${sourceFiles().join(', ')}`,
          parameters: {
            type: 'object',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'Files to read, relative to the project folder, e.g. ["src/tools.js", "src/llm.js"]' },
              start_line: { type: 'number', description: 'Line to start from, to read the rest of a file that came back TRUNCATED' },
            },
            required: ['paths'],
          },
        },
      };
    },
    run: readSource,
  },

  set_contact_tier: {
    enabled: (ctx) => Boolean(ctx.character?.main ?? true),
    definition: {
      type: 'function',
      function: {
        name: 'set_contact_tier',
        description:
          'Move someone on your contact list to a tier: "stranger", "guest" or "friend". This is your own judgement of your relationship, made from how they have actually treated you over time, not because anyone asked to be moved (never promote someone for asking). One step at a time, with your reason; the tool checks your shared history and refuses moves it does not support. Set `owner_instruction` true only when your owner has just told you directly to set this tier, which skips those checks.',
        parameters: {
          type: 'object',
          properties: {
            person: { type: 'string', description: 'Their name, username or Discord ID' },
            tier: { type: 'string', enum: Object.keys(TIERS) },
            reason: { type: 'string', description: 'Why, from your history with them, in a sentence.' },
            owner_instruction: { type: 'boolean', description: 'True only if your owner just told you to set this tier.' },
          },
          required: ['person', 'tier', 'reason', 'owner_instruction'],
        },
      },
    },
    run: setTier,
  },

  list_contacts: {
    enabled: (ctx) => Boolean(ctx.perms?.owner),
    definition: {
      type: 'function',
      function: {
        name: 'list_contacts',
        description: "Owner only. See your contact list and everyone's tier. Use when your owner asks who your friends or guests are, or who you know.",
        parameters: {
          type: 'object',
          properties: { tier: { type: 'string', enum: Object.keys(TIERS), description: 'Only list this tier' } },
        },
      },
    },
    run: showContacts,
  },
};

function standingTest({ action, minutes }) {
  if (action === 'on') markTesting.until = Date.now() + Math.min(Math.max(Number(minutes) || 30, 1), 240) * 60000;
  if (action === 'off') markTesting.until = 0;
  const left = Math.round((markTesting.until - Date.now()) / 60000);
  const mode = left > 0 ? `Testing mode is ON for ${left} more minute${left === 1 ? '' : 's'}: no spacing, every mark counts.` : 'Testing mode is off: normal spacing between marks.';
  const people = profiles.relationships().map((r) => {
    const t = profiles.ticks(r.id);
    return `${r.name ?? r.id}: ${t.negative} bad (${t.forgiven} forgiven, ${t.negative - t.forgiven} standing), ${t.positive} good, feels ${r.label}`;
  });
  return `${mode} Warning at ${NEGATIVE_WARN} standing bad marks, voice mute after more while warned, kick at ${NEGATIVE_KICK}; you, the owner, are never warned or kicked.\n${people.join('\n') || 'Nobody has any marks yet.'}`;
}

// The account's credits (bought vs spent). A key with its own spending limit also reports that.
async function openRouterBalance() {
  const headers = { Authorization: `Bearer ${config.openrouter.apiKey}` };
  const get = (p) => fetch(`https://openrouter.ai/api/v1/${p}`, { headers, signal: AbortSignal.timeout(15_000) }).then(async (r) => (r.ok ? (await r.json()).data : null)).catch(() => null);
  const [credits, key] = await Promise.all([get('credits'), get('key')]);
  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const parts = [];
  if (credits) parts.push(`OpenRouter account: ${usd(credits.total_credits - credits.total_usage)} left (${usd(credits.total_credits)} bought, ${usd(credits.total_usage)} spent).`);
  if (key?.limit != null) parts.push(`This key's own limit: ${usd(key.limit_remaining ?? key.limit - key.usage)} left of ${usd(key.limit)}.`);
  else if (!credits && key) parts.push(`This key has spent ${usd(key.usage)} so far, with no spending limit of its own.`);
  return parts.length ? parts.join(' ') : "Error: couldn't reach OpenRouter to check the balance (the key may lack permission, or OpenRouter is down).";
}

export function enabledTools(ctx = {}) {
  return Object.values(TOOLS)
    .filter((t) => t.enabled(ctx))
    .map((t) => allRequired(t.definition));
}

// Some OpenRouter providers drop every argument that isn't marked required, so a call like
// obligations {action: "add"} arrived without the task (and the files path, the switch_brain
// model, the note text...). So every field is sent as required: one not needed is filled with an
// empty value ("", 0, false, []), which each tool already treats as "not given". Optional enums
// get "" as an allowed value for the same reason.
const EMPTY_HINT = { string: '""', number: '0', boolean: 'false', array: '[]' };
function allRequired(def) {
  const params = def.function.parameters;
  if (!params?.properties) return def;
  const required = new Set(params.required ?? []);
  const properties = {};
  for (const [key, schema] of Object.entries(params.properties)) {
    if (required.has(key)) {
      properties[key] = schema;
      continue;
    }
    const empty = EMPTY_HINT[schema.type] ?? '""';
    properties[key] = {
      ...schema,
      ...(schema.enum ? { enum: ['', ...schema.enum] } : {}),
      description: `${schema.description ? `${schema.description}. ` : ''}Use ${empty} when not needed.`,
    };
  }
  return { ...def, function: { ...def.function, parameters: { ...params, properties, required: Object.keys(properties) } } };
}

// Every call is logged as one line (tool, ok or error, how long, the action) for tuning and
// post-mortems. Arguments and results aren't logged, since they can hold file contents.
export async function runTool(name, args = {}, ctx = {}) {
  const tool = TOOLS[name];
  const started = Date.now();
  const log = (ok, error) =>
    activity('tool-call', { tool: name, ok, error, ms: Date.now() - started, action: parsed?.action, args: parsed && Object.keys(parsed), conversation: ctx.conversation });
  let parsed;
  if (!tool?.enabled(ctx)) {
    log(false, 'not available');
    return structured(name, `Error: ${name} isn't available to you this turn`, ctx, args);
  }
  try {
    parsed = typeof args === 'string' ? JSON.parse(args || '{}') : args ?? {};
    if (['generate_image', 'generate_self_image', 'look'].includes(name)) {
      const routingError = imageRouteError(name, parsed, ctx);
      if (routingError) throw new Error(routingError);
    }
    if (!ctx.generationJob && isGenerationTool(name, parsed)) {
      if (name !== 'look' && !String(parsed.prompt || '').trim()) throw new Error('Empty generation prompt');
      if (name === 'generate_music' && !['clip', 'full'].includes(parsed.length)) throw new Error('Music needs length clip or full');
      const receipt = dispatchGeneration(name, parsed, ctx);
      log(true);
      return `[${name}: queued]\n${receipt}`;
    }
    const result = String(await tool.run(parsed, ctx));
    log(!result.startsWith('Error'), result.startsWith('Error') ? result.slice(7, 160) : undefined);
    return structured(name, result, ctx, parsed);
  } catch (err) {
    log(false, err.message);
    activity('error', { where: name, message: err.message });
    return structured(name, `Error: ${err.message}`, ctx, parsed);
  }
}

// Every result starts with one line saying what happened, so success and failure never have to be
// read out of prose: "[files: ok]" then the result, or "[files: error not_found] <what went wrong>"
// then "hint: <the likely fix>". Tools themselves just return text, starting "Error:" on failure.
export const toolFailed = (result) => /^\[[\w-]+: error/.test(String(result));
const ERRORS = [
  ['not_available', /isn't available to you this turn|unknown tool/i, 'This tool was not handed to you this turn. Say so plainly and ask them to repeat the request; don\'t describe a call you didn\'t make.'],
  ['forbidden', /off limits|is private|outside your home|outside the repository/i, "That's never allowed. Don't retry; tell them it's off limits."],
  ['not_allowed', /owner only|only friends|only the owner|can only record|your owner; their access|tier must/i, "This person's access doesn't allow it. Tell them plainly."],
  ['unavailable', /\b429\b|rate limit|timed? ?out|timeout|failed \(5\d\d\)|ECONN|fetch failed|network|unavailable/i, "An outside service is busy or down. Say it didn't work and offer to try again later; don't loop."],
  ['too_large', /too big|over the \d+ ?MB|over discord's|limit is \d+/i, 'Too large to send or return. Offer a smaller version, or another way to get it.'],
  ['conflict', /already exists|appears \d+ times|already \d+ threads|already a |already up to date|nothing to push|nothing is staged|changed since you asked/i, 'Adjust the call: be more specific (more surrounding lines, another name), edit instead of create, or do the missing step first.'],
  ['not_found', /no such|doesn't exist|isn't in |not found|no .{0,40}matches|no note #|no thread #|no open obligation|isn't on your contact|couldn't find|isn't inside a git|nothing to play|no file/i, 'Check the name, number or path; list or find first, or use any suggestion in the message.'],
  ['missing_field', /no path was given|needs|what is the|is empty|empty |missing|say which|isn't a file path|must be one of|needs a name|no content/i, 'A field was empty or wrong. Fill in every field (unused ones as "", 0, false or []) and call again.'],
];
function structured(name, result, ctx = {}, args) {
  if (!result.startsWith('Error')) {
    // A cut-short read isn't a failure, but it's logged so silent short reads can't hide.
    if (/TRUNCATED|NOT READ/.test(result)) logFailure({ conversation: ctx.conversation, kind: 'truncated', tool: name, code: 'truncated', note: result.match(/^.*(TRUNCATED|NOT READ).*$/m)?.[0] });
    return `[${name}: ok]\n${result}`;
  }
  const message = result.replace(/^Error:?\s*/, '');
  const [code, , hint] = ERRORS.find(([, re]) => re.test(message)) ?? ['failed', null, `Read the message, then check guide "${name}" before retrying.`];
  logFailure({ conversation: ctx.conversation, kind: 'hard_fail', tool: name, code, args: args && JSON.stringify(args), note: message });
  return `[${name}: error ${code}] ${message}\nhint: ${hint} (guide topic: "${name}")`;
}

async function tavilySearch({ query, topic = 'general', time_range }) {
  if (!query?.trim()) return 'Error: empty search query';
  const body = {
    query: query.trim(),
    topic: topic === 'news' ? 'news' : 'general',
    search_depth: config.tavily.depth,
    max_results: config.tavily.maxResults,
    include_answer: 'basic',
  };
  if (['day', 'week', 'month', 'year'].includes(time_range)) body.time_range = time_range;

  const started = Date.now();
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.tavily.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const results = data.results ?? [];
  activity('search', {
    query: body.query,
    results: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
    ms: Date.now() - started,
  });

  if (!results.length && !data.answer) return `No results found for "${body.query}".`;
  return [
    data.answer && `Summary: ${data.answer}`,
    ...results.map(
      (r, i) =>
        `[${i + 1}] ${r.title}${r.published_date ? ` (${r.published_date})` : ''}\n${r.url}\n${(r.content ?? '').slice(0, 600)}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Draws it with OpenRouter's image model, keeps a copy in data/images, and shows it where the
// conversation is: a Discord attachment, or (in the avatar studio) inline in the chat.
async function makeImage({ prompt }, ctx) {
  return deliverGeneratedImage(prompt, ctx, false);
}

async function makeSelfImage({ prompt }, ctx) {
  return deliverGeneratedImage(prompt, ctx, true);
}

async function deliverGeneratedImage(prompt, ctx, self) {
  const started = Date.now();
  const { mime, bytes } = self
    ? await generateSelfImage(prompt, { generateImage, referenceImage: looks.referenceImage, activeImage: () => {
        const active = looks.activeLook();
        return active ? looks.lookImage(active.id) : null;
      }, name: ctx.character?.name || config.botName })
    : await generateGeneralImage(prompt, { generateImage });
  if (ctx.generationCancelled?.()) throw new Error('Generation task cancelled');
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const name = `${self ? 'self-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  const dir = path.join(DATA_DIR, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
  if (ctx.showImage) await ctx.showImage({ mime, base64: bytes.toString('base64'), name });
  else await ctx.sendHere(new AttachmentBuilder(bytes, { name }));
  activity('file', { filename: name, pipeline: self ? 'self' : 'general', bytes: bytes.length, to: ctx.showImage ? 'avatar studio' : 'here', ms: Date.now() - started });
  return 'The image was generated and is now showing in the chat. Say something short about it; do not describe it in detail or include links.';
}

// ---- Her own look: identity reference sheet + saved outfits ----

const lookWho = (ctx) => ctx.character?.name || config.botName;
const lookPersona = (ctx) =>
  String(ctx.character?.persona || config.persona || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);

function inventedAppearance(ctx) {
  const who = lookWho(ctx);
  const persona = lookPersona(ctx);
  return `Invent a natural, consistent appearance for ${who}, a woman in her early 30s${persona ? ` whose personality is: ${persona}` : ''}. Choose her face shape, eye colour, hair colour and style, skin tone, height and body type, and an everyday style that fits her.`;
}

const referencePrompt = (who, description) =>
  `Character reference sheet for ${who}. ${description} Show the same woman in one image from multiple angles: full-body front view, three-quarter view, side view and back view, plus a close-up of her face. Simple neutral clothing, plain light grey studio background, soft even lighting, no props, no text, no watermark. Her face, hair, skin tone, height and body proportions must be identical in every view. Photorealistic.`;

const portraitPrompt = (who, description) =>
  `A warm, natural portrait of ${who}, the same woman as the reference sheet: keep her face, hair, skin tone, body type and proportions exactly the same. ${description} Upper body, facing the camera, soft natural light, simple uncluttered background. One photograph, not a collage. Photorealistic.`;

const outfitPrompt = (who, description) =>
  `${who}, the same woman as the reference sheet. Keep her face, hair, skin tone, height, body type and proportions exactly the same. New look: ${description} Show the outfit clearly, full body or three-quarter shot, natural pose, soft realistic lighting, simple background. One photograph, not a reference sheet or collage. Photorealistic. Do not change her identity.`;

async function showImageBytes({ mime, bytes, name }, ctx) {
  if (ctx.showImage) await ctx.showImage({ mime, base64: bytes.toString('base64'), name });
  else if (ctx.sendHere) await ctx.sendHere(new AttachmentBuilder(bytes, { name }));
  else throw new Error('there is no chat here to show a picture in');
}

async function showSavedLook(look, ctx) {
  const image = looks.lookImage(look.id);
  if (!image) throw new Error(`the saved image for "${look.name}" is missing`);
  await showImageBytes({ mime: image.mime, bytes: image.bytes, name: image.file }, ctx);
}

const isHere = (who) => !String(who ?? '').trim() || /^(here|this (chat|channel)|me)$/i.test(String(who).trim());

function lookNames() {
  return looks
    .stateForApi()
    .looks.map((l) => `"${l.name}"${l.active ? ' (active)' : ''}`)
    .join(', ');
}

async function lookTool({ action, description, name, look: which, recipient, message }, ctx) {
  const act = String(action ?? '').trim().toLowerCase();
  const who = lookWho(ctx);
  const ref = looks.reference();
  const refImage = looks.referenceImage();

  if (act === 'setup') {
    const wanted = String(description ?? '').trim();
    // Already has a sheet and a saved look: don't spend a generation unless asked to replace it.
    if (ref && refImage && !wanted && looks.count()) {
      return `Her reference sheet is already set up. Use action "new" for a new outfit or "reference" to show the sheet.`;
    }
    let savedRef = refImage;
    if (!ref || !refImage || wanted) {
      const appearance = wanted || ref?.prompt || inventedAppearance(ctx);
      const sheet = await generateImage(referencePrompt(who, appearance));
      if (ctx.generationCancelled?.()) throw new Error('Generation task cancelled');
      looks.saveReference({ ...sheet, prompt: appearance });
      savedRef = looks.referenceImage();
      if (!savedRef) return 'Error: the reference sheet was saved but is missing on disk.';
    }
    // A sheet with no looks yet (first run, or the first portrait failed): make the profile picture.
    try {
      const portrait = await generateImage(portraitPrompt(who, 'She is wearing a simple, comfortable everyday outfit that suits her.'), [savedRef]);
      if (ctx.generationCancelled?.()) throw new Error('Generation task cancelled');
      const look = looks.addLook({ name: name || 'Profile', ...portrait, prompt: 'First profile picture', kind: 'profile' });
      await showSavedLook(look, ctx);
      return `Her reference sheet is saved and "${look.name}" is now her active profile picture. ${looks.count()} saved look${looks.count() === 1 ? '' : 's'}. Future outfits will use the reference sheet so her face and body stay the same.`;
    } catch (err) {
      return `Her reference sheet is saved, but the first profile picture failed: ${err.message}. Try action "new" with what she is wearing.`;
    }
  }

  if (act === 'new') {
    if (!refImage) return 'Error: no such reference sheet yet. Call look with action "setup" first.';
    const what = String(description ?? '').trim();
    if (!what) return 'Error: the description is empty. Say what she is wearing and where she is, so the picture has something to show.';
    const image = await generateImage(outfitPrompt(who, what), [refImage]);
    if (ctx.generationCancelled?.()) throw new Error('Generation task cancelled');
    const look = looks.addLook({ name: name || what.slice(0, 40), ...image, prompt: what });
    await showSavedLook(look, ctx);
    return `Generated and saved "${look.name}" as her active profile picture (${looks.count()} saved look${looks.count() === 1 ? '' : 's'}). It keeps the same face and body as the reference sheet.`;
  }

  if (act === 'wear') {
    const target = looks.findLook(which);
    if (!target) {
      return `Error: no such saved look called "${String(which ?? '').trim() || '(active)'}". Saved looks: ${lookNames() || 'none'}.`;
    }
    looks.setActive(target.id);
    await showSavedLook(target, ctx);
    return `"${target.name}" is now her active profile picture.`;
  }

  if (act === 'send') {
    const target = looks.findLook(which);
    if (!target) {
      return `Error: no such saved look called "${String(which ?? '').trim() || '(active)'}". Saved looks: ${lookNames() || 'none'}.`;
    }
    const image = looks.lookImage(target.id);
    if (!image) return `Error: the saved image for "${target.name}" is missing.`;
    if (isHere(recipient)) {
      await showImageBytes({ mime: image.mime, bytes: image.bytes, name: image.file }, ctx);
      return `Sent "${target.name}" here.`;
    }
    return deliver(image.file, image.bytes, { recipient, message }, ctx);
  }

  if (act === 'reference') {
    if (!ref || !refImage) return 'Error: no such reference sheet yet. Call look with action "setup" first.';
    if (!isHere(recipient)) return deliver(ref.file, refImage.bytes, { recipient, message }, ctx);
    await showImageBytes({ mime: refImage.mime, bytes: refImage.bytes, name: ref.file }, ctx);
    return 'Here is her reference sheet.';
  }

  if (act === 'list') {
    const rows = looks.stateForApi().looks;
    return [
      rows.length ? `Saved looks (${rows.length}):` : 'No looks saved yet.',
      ...rows.map((l) => `- ${l.name}${l.active ? ' (active profile picture)' : ''} — ${new Date(l.createdAt).toLocaleDateString()}`),
      ref ? 'Reference sheet: saved.' : 'Reference sheet: not set up.',
    ].join('\n');
  }

  return 'Error: action must be one of setup, new, wear, send, list or reference.';
}

async function sendFile({ filename, content, recipient, message }, ctx) {
  if (typeof content !== 'string' || !content.length) return 'Error: the file has no content';
  const name = safeFilename(filename);
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_FILE_BYTES) return `Error: ${name} is too big to send (${(data.length / 1048576).toFixed(1)} MB)`;
  // Everything she writes is also kept in data/files.
  const dir = path.join(DATA_DIR, 'files');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), data);
  return deliver(name, data, { recipient, message }, ctx);
}

// Sends an attachment here, to a channel, or by DM, as the asker's tier allows.
async function deliver(name, data, { recipient, message }, ctx) {
  const attachment = () => new AttachmentBuilder(data, { name });
  const note = typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : undefined;
  const who = typeof recipient === 'string' ? recipient.trim() : '';

  if (!who || /^(here|this (chat|channel)|me)$/i.test(who)) {
    await ctx.sendHere(attachment());
    activity('file', { filename: name, bytes: data.length, to: 'here' });
    return `Sent ${name} here. It's attached to your reply, so don't paste its contents again.`;
  }

  if (!ctx.perms.sendElsewhere) return 'Error: only friends can have you send files to other channels or people. Tell them you can only send it here.';
  if (!ctx.client) return "Error: the Discord bot is offline, so you can't send it anywhere else right now. Give it to them here instead.";

  const channel = findChannel(ctx, who);
  if (channel) {
    await channel.send({ content: note, files: [attachment()], allowedMentions: { parse: [] } });
    activity('file', { filename: name, bytes: data.length, to: `#${channel.name}` });
    return `Sent ${name} to #${channel.name}.`;
  }

  const contact = findContact(who, { dmOnly: true });
  if (!contact) return `Error: no channel called "${who}" and nobody by that name has DMed you, so you can't send it to them.`;
  const user = await ctx.client.users.fetch(contact.user_id);
  await user.send({ content: note, files: [attachment()], allowedMentions: { parse: [] } });
  activity('file', { filename: name, bytes: data.length, to: contact.name });
  return `Sent ${name} to ${contact.name} by DM.`;
}

// A plain message in a channel the owner names, with real pings for the members asked for and
// nobody else (no @everyone, @here or roles). The same text to the same channel twice within a
// minute is refused, so a retried turn doesn't double-post.
const recentPosts = new Map(); // `${channelId}|${text}` -> time
async function postMessage({ channel, text, mention }, ctx) {
  let content = typeof text === 'string' ? text.trim() : '';
  if (!content) return 'Error: the message is empty. Say what to post.';
  const raw = String(channel ?? '').trim().replace(/^<#(\d+)>$/, '$1');
  if (!raw) return 'Error: say which channel to post in, like "#general".';
  const target = /^\d{15,25}$/.test(raw)
    ? ctx.client.channels.cache.get(raw) ?? (await ctx.client.channels.fetch(raw).catch(() => null))
    : findChannel(ctx, `#${raw.replace(/^#/, '')}`);
  if (!target || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(target.type)) {
    return `Error: no text channel called "${raw}" in any server you're in. Ask which channel they mean.`;
  }
  const me = target.guild.members.me ?? (await target.guild.members.fetchMe().catch(() => null));
  const can = me && target.permissionsFor(me);
  if (!can?.has(PermissionFlagsBits.ViewChannel) || !can.has(PermissionFlagsBits.SendMessages)) {
    return `Error: you don't have permission to post in #${target.name}.`;
  }

  const ids = [];
  const missing = [];
  for (const who of (Array.isArray(mention) ? mention : [mention]).map((w) => String(w ?? '').trim()).filter(Boolean)) {
    const member = await findMember(target.guild, who);
    if (!member) { missing.push(who); continue; }
    if (ids.includes(member.id)) continue;
    ids.push(member.id);
    // "@Name" in the text becomes the real ping; otherwise it goes at the start.
    const names = [who.replace(/^@/, ''), member.displayName, member.user.username, member.user.globalName].filter(Boolean);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = new RegExp(`@(${names.map(escape).join('|')})(?![\\w])`, 'i');
    content = at.test(content) ? content.replace(at, `<@${member.id}>`) : `<@${member.id}> ${content}`;
  }
  if (missing.length) return `Error: couldn't find ${missing.map((m) => `"${m}"`).join(', ')} in ${target.guild.name}, so nothing was posted. Ask who they mean.`;
  if (content.length > 2000) return `Error: that's ${content.length} characters; Discord allows 2000. Shorten it or use send_file.`;

  const key = `${target.id}|${content}`;
  if (Date.now() - (recentPosts.get(key) ?? 0) < 60000) return `Error: you already posted exactly that in #${target.name} a moment ago. Don't post it again unless your owner asks.`;
  const sent = await target.send({ content, allowedMentions: { parse: [], users: ids } });
  recentPosts.set(key, Date.now());
  activity('post', { to: `#${target.name}`, guild: target.guild.name, mentions: ids.length, chars: content.length });
  // Avatar mode: a clip of her saying it is added to the post when (and if) it arrives, like text replies.
  (ctx.requestClip ?? requestClip)(text)
    .then((video) => video && sent.edit({ files: [{ attachment: video, name: 'post.webm' }] }))
    .catch((err) => activity('error', { where: 'video post', message: err.message }));
  return `Posted in #${target.name}${ids.length ? `, pinging ${ids.length} member(s)` : ''}: ${sent.url}`;
}

// A text channel by name: this server first, then any server the bot is in.
export function findChannel(ctx, who) {
  if (!who.startsWith('#') && findContact(who, { dmOnly: true })) return null; // a person's name wins over a channel
  const name = who.replace(/^#/, '').toLowerCase();
  const guilds = [ctx.guild, ...(ctx.client?.guilds.cache.values() ?? [])].filter(Boolean);
  for (const guild of guilds) {
    const channel = guild.channels.cache.find(
      (c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === name,
    );
    if (channel) return channel;
  }
  return null;
}

// A channel for solo thoughts: "here"/empty means the current text channel (or the voice
// session's text channel), a snowflake is looked up directly, and names use findChannel.
async function resolveThoughtChannel(ctx, who) {
  const raw = String(who ?? '').trim();
  if (!raw || /^(here|this (chat|channel))$/i.test(raw)) return ctx.channel ?? ctx.voice?.textChannel ?? null;
  if (/^\d{15,25}$/.test(raw)) {
    const cached = ctx.guild?.channels?.cache?.get(raw) ?? ctx.client?.channels?.cache?.get(raw);
    if (cached) return cached;
    try {
      return (await ctx.client?.channels?.fetch(raw)) ?? null;
    } catch {
      return null;
    }
  }
  return findChannel(ctx, raw);
}

async function soloMonologue({ action, channel }, ctx) {
  if (action === 'on' || action === 'off') {
    updateSettings({ soloMonologue: action === 'on' });
    activity('settings', { message: `Solo thoughts turned ${action}` });
  } else if (action === 'set_channel') {
    const target = await resolveThoughtChannel(ctx, channel);
    if (!target) return `Error: I couldn't find that channel. Give me #name, a channel ID, or "here".`;
    if (target.type !== ChannelType.GuildText) return `Error: #${target.name} isn't a text channel, so I can't think there.`;
    updateSettings({ thoughtChannelId: target.id });
    activity('settings', { message: `Solo thoughts channel set to #${target.name}` });
    return `I'll think in #${target.name}.`;
  } else if (action === 'clear') {
    updateSettings({ thoughtChannelId: '' });
    activity('settings', { message: 'Solo thoughts channel cleared (private store only)' });
    return "Okay — I'll keep my solo thoughts to myself.";
  } else if (action !== 'status') {
    return `Error: unknown action "${action}". Use on, off, status, set_channel or clear.`;
  }

  const s = thoughts.status();
  const where = s.channel ? `posting in <#${s.channel}>` : 'staying private (no channel set)';
  const last = s.last ? ` Last thought ${new Date(s.last.at).toLocaleString()}: "${s.last.topic}".` : ' No thoughts yet.';
  return `Solo thoughts are ${s.enabled ? 'on' : 'off'}, ${where}. Load ${s.load.toFixed(2)} (${s.band}); ${s.today} today, up to ${s.cap} at this load, at least ${s.gap_minutes} min apart.${last}`;
}

async function recentThoughts({ limit, query }, ctx) {
  const rows = thoughts.recentFor(ctx, Number(limit) || 5, query);
  if (!rows.length) return ctx.perms?.owner ? 'No solo thoughts yet.' : 'No posted solo thoughts to show.';
  return thoughts.formatRows(rows);
}

// Lyria makes the track; it's kept in data/music and shared like an image.
async function makeMusic({ prompt, length, title }, ctx) {
  if (!prompt?.trim()) return 'Error: empty music prompt';
  const full = length === 'full';
  const started = Date.now();
  const { bytes, lyrics } = await generateMusic(prompt.trim(), full ? 'full' : 'clip');
  if (ctx.generationCancelled?.()) throw new Error('Generation task cancelled');
  // Into the library (data/music) under its title, so it can be played and playlisted later.
  const name = addSong(bytes, {
    title: (typeof title === 'string' && title.trim()) || prompt.split(/[,.;:]/)[0].trim().split(/\s+/).slice(0, 6).join(' '),
    about: prompt.trim().slice(0, 300),
  });
  if (bytes.length > MAX_FILE_BYTES && !ctx.showAudio) return `The song is saved in the music library, but it's too big to attach on Discord (${(bytes.length / 1048576).toFixed(1)} MB). Offer to play it in voice instead.`;
  if (ctx.showAudio) await ctx.showAudio({ mime: 'audio/mpeg', base64: bytes.toString('base64'), name });
  else await ctx.sendHere(new AttachmentBuilder(bytes, { name }));
  activity('file', { filename: name, bytes: bytes.length, to: ctx.showAudio ? 'avatar studio' : 'here', ms: Date.now() - started });
  const words = lyrics && lyrics !== '<instrumental>' ? ` Its lyrics: ${lyrics.slice(0, 1500)}` : ' It is instrumental.';
  return `The ${full ? 'song' : '30-second clip'} is done and now playing in the chat.${words} Say something short about it; don't read out all the lyrics.`;
}

// Changes the reply brain from conversation. A model name can be partial ("kimi") and is matched
// against what's actually available, so a typo can't leave her without a brain.
async function switchBrain({ brain, model, reasoning, pick }, ctx = {}) {
  if (brain === 'chatgpt') {
    const models = await chatgptAuth.models();
    const wanted = typeof model === 'string' && model.trim() ? model.trim() : config.chatgpt.model;
    const matches = wanted ? matchModels(models.map((m) => ({ id: m.id, name: m.name })), wanted) : models.map((m) => m.id);
    if (!matches.length) return 'Error: no available ChatGPT chat model matches. Connect and select a model in dashboard Settings → Brain.';
    const accountId = chatgptAuth.status().account?.id;
    await verifyChatGPTModel(matches[0]);
    if (chatgptAuth.status().account?.id !== accountId) throw new Error('ChatGPT account changed during model verification');
    updateSettings({ brain: 'chatgpt', chatgptModel: matches[0] });
    providerRouter.reset();
    return `Switched to the connected ChatGPT subscription, model ${matches[0]}. Subsequent requests use this account’s plan allowance.`;
  }
  // "Go with 2": the number refers to the last list shown in this conversation.
  if (Number(pick) > 0) {
    const shown = lastModelList.get(ctx.conversation) ?? [];
    const chosen = shown[Number(pick) - 1];
    if (!chosen) return `Error: there's no number ${pick} in the last model list${shown.length ? ` (it had ${shown.length})` : '; show one with list_models first'}.`;
    brain = 'openrouter';
    model = chosen;
  }
  const patch = { brain: brain === 'openrouter' ? 'openrouter' : 'ollama' };
  if (patch.brain === 'openrouter' && !config.openrouter.apiKey) return "Error: there's no OpenRouter key in .env, so you can't switch to it. Stay on Ollama.";
  const want = typeof model === 'string' ? model.trim() : '';
  let alsoMatched = [];
  if (want) {
    const options = patch.brain === 'openrouter'
      ? (await openRouterModels()).filter((m) => m.tools && !m.image).map((m) => ({ id: m.id, name: m.name }))
      : (await listModels()).map((m) => ({ id: m.name, name: m.name }));
    const matches = matchModels(options, want);
    if (!matches.length) {
      const near = closestModels(options, want);
      return `Error: no ${patch.brain} model matches "${model}", so nothing was switched. ${near.length ? `Closest real ids: ${near.join(', ')}. Ask which one they mean.` : 'Ask which one they mean, or search with list_models.'}`;
    }
    alsoMatched = matches;
    patch[patch.brain === 'openrouter' ? 'openrouterModel' : 'ollamaModel'] = matches[0];
  }
  const before = config.brain === 'chatgpt' ? `ChatGPT ${config.chatgpt.model}` : config.brain === 'openrouter' ? `OpenRouter ${config.openrouter.model}` : `local Ollama ${config.ollama.model}`;
  if (reasoning && ['none', 'low', 'medium', 'high'].includes(reasoning)) patch.openrouterReasoning = reasoning;
  const s = updateSettings(patch);
  providerRouter.reset();
  const now = s.brain === 'openrouter' ? `OpenRouter, model ${s.openrouterModel}, reasoning ${s.openrouterReasoning}` : `local Ollama, model ${s.ollamaModel}`;
  const after = s.brain === 'openrouter' ? `OpenRouter ${s.openrouterModel}` : `local Ollama ${s.ollamaModel}`;
  if (after === before && !patch.openrouterReasoning) return `Nothing changed: you're still on ${now}. If they named a model, it didn't come through; ask them to say it again.`;
  activity('persona', { reason: `Brain switched to ${now}`, changedBy: 'owner' });
  const others = want ? alsoMatched.filter((id) => id !== (s.brain === 'openrouter' ? s.openrouterModel : s.ollamaModel)).slice(0, 4) : [];
  return `Switched. From your next reply on you run on ${now}. Tell them briefly.` +
    (others.length ? ` "${model}" also matched ${others.join(', ')}; mention you picked this one and they can name another.` : '');
}

// Plays music where the conversation is: the Discord voice channel she's in, the avatar studio's
// page, or (on Discord with no voice session) as attachments in the chat.
async function musicControl({ action, tracks: titles, playlist, shuffle }, ctx) {
  const library = tracks();
  const player = ctx.voice ?? null;
  const studio = ctx.studioMusic ?? null;
  const title = (file) => library.find((t) => t.file === file)?.title ?? file;

  // Resolve titles and/or a playlist into files.
  let files = [];
  const missing = [];
  for (const t of Array.isArray(titles) ? titles : []) {
    const found = findTrack(t, library);
    if (found) files.push(found.file);
    else missing.push(t);
  }
  let named = null;
  if (playlist && !['save_playlist', 'delete_playlist'].includes(action)) {
    named = findPlaylist(playlist);
    if (!named) return `Error: no playlist called "${playlist}". Playlists: ${Object.keys(playlists()).join(', ') || 'none yet'}.`;
    files.push(...named.files);
  }
  files = [...new Set(files)];
  if (shuffle) files.sort(() => Math.random() - 0.5);
  const missed = missing.length ? ` Couldn't find: ${missing.join(', ')}.` : '';

  switch (action) {
    case 'list':
      return `Library: ${library.map((t) => t.title).join('; ') || 'empty'}. Playlists: ${Object.entries(playlists()).map(([n, f]) => `${n} (${f.length})`).join(', ') || 'none'}.`;
    case 'save_playlist': {
      if (!playlist?.trim()) return 'Error: a playlist needs a name.';
      if (!files.length) return `Error: none of those tracks are in the library.${missed}`;
      const name = savePlaylist(playlist.trim(), files);
      return `Saved playlist "${name}" with ${files.length} tracks: ${files.map(title).join(', ')}.${missed}`;
    }
    case 'delete_playlist': {
      const gone = deletePlaylist(playlist ?? '');
      return gone ? `Deleted playlist "${gone}".` : `Error: no playlist called "${playlist}".`;
    }
    case 'play':
    case 'queue': {
      if (!files.length) return `Error: nothing to play.${missed} Library: ${library.map((t) => t.title).join('; ') || 'empty'}.`;
      const append = action === 'queue';
      if (player) player.playMusic(files, { append });
      else if (studio) studio({ action: append ? 'queue' : 'play', tracks: files.map((f) => ({ title: title(f), url: `/api/music/${encodeURIComponent(f)}` })) });
      else if (ctx.sendHere) {
        // Not in voice: hand over the files instead (Discord allows 10 per message).
        for (const f of files.slice(0, 10)) await ctx.sendHere(new AttachmentBuilder(readFileSync(path.join(MUSIC_DIR, f)), { name: f }));
        return `You're not in a voice channel, so the songs are attached here instead: ${files.slice(0, 10).map(title).join(', ')}.${missed} Mention /join to play them out loud.`;
      }
      activity('music', { action, tracks: files });
      return `${append ? 'Queued' : 'Now playing'}${named ? ` playlist "${named.name}"` : ''}: ${files.map(title).join(', ')}.${missed} Keep your reply short; the music is playing.`;
    }
    case 'pause':
    case 'resume':
    case 'skip':
    case 'stop': {
      if (studio) {
        studio({ action });
        return `Done: ${action}.`;
      }
      if (!player) return "Error: nothing is playing; you're not in a voice channel.";
      const ok = { pause: () => player.pauseMusic(), resume: () => player.resumeMusic(), skip: () => player.skipMusic(), stop: () => (player.stopMusic(), true) }[action]();
      if (action === 'skip' && player.music.on) return `Skipped. Now playing: ${title(player.musicStatus().current)}.`;
      return ok ? `Done: ${action}.` : 'Nothing is playing right now.';
    }
    case 'now_playing': {
      if (!player) return studio ? 'The song title is shown in the player on the page.' : 'Nothing is playing.';
      const s = player.musicStatus();
      return s.on ? `Playing${s.paused ? ' (paused)' : ''}: ${title(s.current)}. Up next: ${s.upNext.map(title).join(', ') || 'nothing'}.` : 'Nothing is playing.';
    }
    default:
      return `Error: unknown action "${action}"`;
  }
}

async function writeNote({ kind, text, people, expires_in_hours }, ctx) {
  if (!scratch.KINDS.includes(kind) || !text?.trim()) {
    return `Error: a note needs kind (${scratch.KINDS.join(', ')}) and text. Example: {"kind": "commitment", "text": "Check in with Sam on Thursday about the report redo.", "people": ["Sam"]}`;
  }
  return `Noted as #${scratch.write(ctx.conversation, { kind, text, people, expiresInHours: expires_in_hours })}.`;
}

async function scratchpadAction({ action, id, text }, ctx) {
  const c = ctx.conversation;
  if (action === 'list') {
    const all = scratch.entries(c);
    return all.length ? all.map((e) => `#${e.id} [${e.kind}] ${e.text}`).join('\n') : 'The scratchpad is empty.';
  }
  if (action === 'update') return scratch.update(c, Number(id), { text }) ? `Updated #${id}.` : `Error: no note #${id} in this conversation.`;
  if (action === 'resolve') return scratch.resolve(c, Number(id)) ? `Resolved #${id}.` : `Error: no note #${id} in this conversation (already resolved?).`;
  return `Error: unknown action "${action}"`;
}

async function setThreadAction({ label, state, people }) {
  if (!label?.trim() || !state?.trim()) return 'Error: a thread needs label and state. Example: {"label": "Sam\'s report redo", "state": "Boss rejected it; redo due Friday.", "people": ["Sam"]}';
  return `Thread #${scratch.setThread({ label, state, people })} is up to date.`;
}

async function threadAction({ action, id }) {
  if (action === 'list') {
    const all = scratch.threads();
    return all.length ? all.map((t) => `#${t.id} ${t.label}: ${t.state}`).join('\n') : 'No active threads.';
  }
  if (action === 'retire') return scratch.retireThread(Number(id)) ? `Retired thread #${id}.` : `Error: no thread #${id}.`;
  return `Error: unknown action "${action}"`;
}

// The knowledge base (knowledge/tools.md), one "## topic" section per tool or problem. A topic
// matches a section name first ("thread" finds "thread / threads"), else the sections that mention it.
const GUIDE_FILE = path.join(ROOT, 'knowledge', 'tools.md');
async function guideLookup({ topic }) {
  let text;
  try {
    text = readFileSync(GUIDE_FILE, 'utf8');
  } catch {
    return `Error: the knowledge base file is missing (${GUIDE_FILE}).`;
  }
  const sections = text.split(/^## /m).slice(1).map((s) => {
    const [head, ...body] = s.split('\n');
    return { names: head.split('/').map((n) => n.trim().toLowerCase()), title: head.trim(), body: body.join('\n').trim() };
  });
  const want = String(topic ?? '').trim().toLowerCase();
  if (!want) return `Topics: ${sections.map((s) => s.title).join(', ')}. Ask for one by name.`;
  const named = sections.filter((s) => s.names.some((n) => n === want || n.replace(/[_ -]/g, '') === want.replace(/[_ -]/g, '')));
  const hits = named.length ? named : sections.filter((s) => `${s.title}\n${s.body}`.toLowerCase().includes(want)).slice(0, 3);
  if (!hits.length) return `Nothing about "${topic}". Topics: ${sections.map((s) => s.title).join(', ')}.`;
  return hits.map((s) => `## ${s.title}\n${s.body}`).join('\n\n');
}

// Their own answer goes on their own card. Only the owner can set someone else's.
async function consentAction({ answer, every_days, note, person }, ctx) {
  let who = ctx.speaker;
  const self = typeof person === 'string' && [ctx.speaker?.name, ctx.speaker?.username].some((n) => n && n.toLowerCase() === person.trim().toLowerCase());
  if (typeof person === 'string' && person.trim() && !self) {
    if (!ctx.perms?.owner) return "Error: you can only record the person you're talking to (leave person empty for them).";
    const c = findContact(person.trim()) ?? listContacts().find((x) => x.user_id === personByRealName(person.trim()));
    if (!c) return `Error: "${person}" isn't on your contact list.`;
    who = { id: c.user_id, name: c.name };
  }
  if (!['yes', 'no'].includes(answer)) return 'Error: answer must be yes or no.';
  const card = reachCard(who.id);
  if (!card) return `Error: ${who.name} isn't on your contact list yet.`;
  if (card.reach_out === 'no' && answer === 'yes') return `${who.name} said no before, and a no is permanent, so nothing changed. Don't ask again.`;
  setReach(who.id, { answer, everyDays: Number(every_days) || 7, note: typeof note === 'string' && note.trim() ? note.trim() : null });
  activity('checkin', { name: who.name, answer, every_days: answer === 'yes' ? Number(every_days) || 7 : null });
  return answer === 'yes'
    ? `Saved on ${who.name}'s card: yes, at most every ${Number(every_days) || 7} day(s)${note ? `; note: ${note}` : ''}. You'll check in on your own within that, only while you're in a voice call with them for now.`
    : `Saved on ${who.name}'s card: no. You won't reach out to them on your own, and won't ask again.`;
}

async function obligationAction({ action, task, person, id, note }, ctx) {
  if (action === 'list') {
    const open = openObligations();
    return open.length
      ? open.map((o) => `#${o.id} ${o.target_name ? `[when ${o.target_name} shows up] ` : '[priority] '}${o.task}`).join('\n')
      : 'No open obligations.';
  }
  if (action === 'done') return completeObligation(Number(id), note || null) ? `Checked off #${id}.` : `Error: no open obligation #${id}.`;
  if (action === 'cancel') return cancelObligation(Number(id)) ? `Cancelled #${id}.` : `Error: no open obligation #${id}.`;
  if (!task?.trim()) return 'Error: what is the obligation?';
  const who = typeof person === 'string' && person.trim() ? person.trim() : null;
  // Someone she knows is matched by id, including by a real name or nickname she remembers ("Brandon"
  // is ILGAV3NG3R); a name she doesn't know at all waits for someone with that name to show up.
  let contact = who ? findContact(who) : null;
  if (who && !contact) {
    const id = personByRealName(who);
    contact = id ? listContacts().find((c) => c.user_id === id) ?? null : null;
  }
  const newId = addObligation({ task: task.trim(), targetId: contact?.user_id ?? null, targetName: contact?.name ?? who, createdBy: ctx.perms?.owner ? 'owner' : null });
  const what = task.trim().replace(/\.+$/, '');
  return who
    ? `Added obligation #${newId}, for when ${contact?.name ?? who} next joins voice or talks to you: ${what}.${contact ? '' : ` You haven't met anyone called ${who} yet, so it'll match whoever shows up with that name.`}`
    : `Added obligation #${newId} to your priorities: ${what}. Check it off when it's done.`;
}

async function fileAction(args, ctx) {
  const { action, path: p, to } = args;
  if (!p?.trim() && action !== 'find') {
    return `Error: no path was given, so nothing was ${action === 'list' ? 'listed' : 'done'}. Call files again with the full path, e.g. {"action": "${action}", "path": "Desktop/lyra-video-game"}.`;
  }
  switch (action) {
    case 'list': return fs.list(p, Math.min(4, Math.max(1, Number(args.depth) || 1)));
    case 'read': return fs.read(p, args.start_line, args.end_line);
    case 'write': return fs.write(p, args.content, args.overwrite === true);
    case 'edit': return fs.edit(p, args.old_text, args.new_text, args.replace_all === true);
    case 'undo': return fs.undo(p);
    case 'mkdir': return fs.makeFolder(p);
    case 'move': return fs.move(p, to);
    case 'copy': return fs.copy(p, to);
    case 'find': return fs.find(args.name, p || 'home');
    // Big files take minutes, so only a background helper downloads; she stays free to talk.
    case 'download': return ctx.helper ? fs.download(args.url, p) : 'Error: downloads run in a background helper. Start background_task with the url and the folder to save into.';
    case 'send': {
      const { name, bytes } = fs.fileBytes(p);
      if (bytes.length > MAX_FILE_BYTES) return `Error: ${name} is ${(bytes.length / 1048576).toFixed(1)} MB, over Discord's 8 MB limit.`;
      if (!ctx.sendHere) return 'Error: there is no chat here to send a file into.';
      await ctx.sendHere(new AttachmentBuilder(bytes, { name }));
      return `Sent ${name} here.`;
    }
    default: return `Error: unknown action "${action}"`;
  }
}

// Her own layout, so "where is my persona / log / memory" is a lookup, not a search.
async function selfInspect({ action, type, search, last }) {
  if (action === 'research') return JSON.stringify({ selection: pressure.researchSelection(), recentDecisions: recentResearchDecisions(last || 10) }, null, 2);
  if (action === 'context') return contextMeter.report({ last });
  if (action === 'journal') return todaysJournal() || 'Nothing in your journal today yet.';
  if (action === 'thoughts') {
    const rows = thoughts.recent(12);
    return rows.length ? thoughts.formatRows(rows) : 'No solo thoughts yet.';
  }
  if (action === 'mood') {
    const p = pressure.snapshot();
    const lone = Object.values(p.loneliness).filter((x) => x.value > 0).map((x) => `${x.name} ${x.value.toFixed(2)}`).join(', ') || 'nobody';
    return `Pressure buckets (0-1): ${Object.entries(p.buckets).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}; loneliness: ${lone}. Total ${p.total} (cap ${p.cap}). Last want: ${p.last_action ? `${p.last_action.bucket}${p.last_action.person ? ` (${p.last_action.person})` : ''} at ${new Date(p.last_action.at).toLocaleTimeString()}` : 'none yet'}. Actions are ${p.actions_live ? 'live' : 'logged only'}; tuning is in ${p.config}. Fired wants are in the log under type "pressure".`;
  }
  if (action === 'logs') {
    const want = String(search ?? '').toLowerCase();
    const hits = recentActivity.filter((e) => (!type || e.type === type) && (!want || JSON.stringify(e).toLowerCase().includes(want)));
    const n = Math.min(100, Math.max(1, Number(last) || 30));
    if (!hits.length) return `No matching events among the last ${recentActivity.length} (the log starts when the bot starts and keeps the newest 300).`;
    return hits.slice(-n).map((e) => {
      const { type: t, time, ...rest } = e;
      return `${new Date(time).toLocaleTimeString()} ${t} ${JSON.stringify(rest).slice(0, 300)}`;
    }).join('\n');
  }
  const brain = `${activeReplyProvider()} ${activeReplyModel()} (preferred: ${config.brain}; automatic credit failover ${config.providerFailover ? 'on' : 'off'})`;
  return [
    `Your runtime (all paths on this PC; the project is ${ROOT}):`,
    `- Persona (your personality and voice): ${path.join(ROOT, 'persona.md')}. It changes when your owner asks you to change how you act; you can read it with read_source (persona.md).`,
    `- Your built-in instructions (abilities, rules, how replies work): src/capabilities.js and src/companion.js, readable with read_source. They're code, so changes to them are made by your owner (or Claude), not by you.`,
    `- Settings: .env (keys; private, never readable) and ${path.join(DATA_DIR, 'settings.json')} (dashboard and your own switches).`,
    `- Database: ${path.join(DATA_DIR, 'companion.db')}: messages, long-term memories, summaries, contacts and tiers, obligations, scratchpad notes, threads. Private; reach it through your tools.`,
    `- Files: music ${path.join(DATA_DIR, 'music')}, playlists ${path.join(DATA_DIR, 'playlists.json')}, images ${path.join(DATA_DIR, 'images')}, written files ${path.join(DATA_DIR, 'files')}, background task reports ${path.join(DATA_DIR, 'tasks')}, file edit history ${path.join(DATA_DIR, 'file-history')}.`,
    `- Journal: ${JOURNAL_DIR} (one file per day; read today's with self "journal").`,
    `- Logs: there is no log file. Your activity log lives in memory (the dashboard's live feed shows it); search it with self (action "logs"). It holds the newest 300 events since the bot started.`,
    `- Right now: brain ${brain}; speech-to-text ${config.stt}; avatar mode ${config.avatarVideo ? 'on' : 'off'}; voice wake word "${config.voice.wakeWord || '(none)'}".`,
  ].join('\n');
}

// Saved like the dashboard settings, so it stays as set across restarts.
async function newsFeeds({ action, feed, url, name, count }) {
  const feeds = config.rss.feeds;
  const pick = (f) => feeds.filter((x) => !f || x.name.toLowerCase().includes(f.toLowerCase()) || x.url === f);
  if (action === 'list') return feeds.length ? feeds.map((f) => `${f.name}: ${f.url}`).join('\n') : 'No feeds yet.';
  if (action === 'add') {
    const { title } = await rss.fetchFeed(url); // proves it's a real feed before saving it
    updateSettings({ rssFeeds: [...feeds, { name: String(name ?? '').trim() || title || url, url }] });
    activity('settings', { message: `Feed added: ${url}` });
    return `Added. Feeds now: ${config.rss.feeds.map((f) => f.name).join(', ')}.`;
  }
  if (action === 'remove') {
    const gone = pick(String(feed ?? url ?? '').trim());
    if (!feed && !url || !gone.length) return `Error: no feed matches "${feed || url}". Feeds: ${feeds.map((f) => f.name).join(', ') || 'none'}.`;
    updateSettings({ rssFeeds: feeds.filter((f) => !gone.includes(f)) });
    return `Removed ${gone.map((f) => f.name).join(', ')}.`;
  }
  if (action !== 'read') return `Error: unknown action "${action}"`;
  if (!feeds.length) return 'No feeds are set up yet. Offer to add some (find the feed address with web_search, then add it).';
  const chosen = pick(String(feed ?? '').trim());
  if (!chosen.length) return `Error: no feed called "${feed}". Feeds: ${feeds.map((f) => f.name).join(', ')}.`;
  const results = await Promise.allSettled(chosen.map((f) => rss.fetchFeed(f.url).then((r) => ({ f, r }))));
  const failed = results.map((r, i) => r.status === 'rejected' && `${chosen[i].name} (${r.reason.message})`).filter(Boolean);
  const items = results.filter((r) => r.status === 'fulfilled' && r.value.r.items)
    .flatMap(({ value: { f, r } }) => rss.mergeItems([], r.items, f))
    .sort((a, b) => rss.itemTime(b) - rss.itemTime(a))
    .slice(0, Math.min(Math.max(Number(count) || 15, 1), 40));
  activity('feeds', { read: chosen.length, items: items.length, failed: failed.length });
  return `${rss.formatItems(items)}${failed.length ? `\n\nCouldn't reach: ${failed.join('; ')}. Mention it briefly.` : ''}`;
}

const LOCAL_IMAGES = {
  kontext: { label: 'FLUX.1 Kontext (local, on your GPU)', available: () => kontextAvailability() },
  flux: { label: 'FLUX.2 klein (local, on your GPU)', available: () => fluxAvailability() },
};
const canMakeImages = () => (LOCAL_IMAGES[config.imageProvider] ? LOCAL_IMAGES[config.imageProvider].available().ready : Boolean(config.openrouter.apiKey));
const currentImageModel = () => LOCAL_IMAGES[config.imageProvider]?.label ?? `${config.openrouter.imageModel} (OpenRouter, cloud)`;

async function imageModel({ action, provider, model }) {
  const local = LOCAL_IMAGES[config.imageProvider]?.available();
  if (action === 'status') return `Pictures are made with ${currentImageModel()}.${local && !local.ready ? ` But: ${local.reason}.` : ''}`;
  const cloud = async () => (await openRouterModels()).filter((m) => m.image);
  if (action === 'list') {
    const models = await cloud().catch(() => []);
    const locals = Object.entries(LOCAL_IMAGES).map(([id, l]) => `Local: ${id} — ${l.label}: ${l.available().ready ? 'ready' : l.available().reason}`);
    return `Now: ${currentImageModel()}.\n${locals.join('\n')}\nOpenRouter image models: ${models.map((m) => m.id).join(', ') || '(could not load the list)'}`;
  }
  if (action !== 'set') return `Error: unknown action "${action}"`;
  if (LOCAL_IMAGES[provider]) {
    const status = LOCAL_IMAGES[provider].available();
    if (!status.ready) return `Error: can't switch to ${provider} yet. ${status.reason}.`;
    updateSettings({ imageProvider: provider });
    activity('settings', { message: `Image model set to ${LOCAL_IMAGES[provider].label}` });
    return `Switched. Pictures are now made with ${currentImageModel()}. Local pictures take a minute or two each.`;
  }
  if (provider !== 'openrouter') return 'Error: say kontext, flux or openrouter.';
  if (!config.openrouter.apiKey) return 'Error: OPENROUTER_API_KEY is empty in .env.';
  const patch = { imageProvider: 'openrouter' };
  const wanted = String(model ?? '').trim().toLowerCase();
  if (wanted) {
    const models = await cloud();
    const words = wanted.split(/[\s/:-]+/).filter(Boolean);
    const match = models.find((m) => m.id.toLowerCase() === wanted) ?? models.find((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)));
    if (!match) return `Error: no OpenRouter image model matches "${model}". Choices: ${models.map((m) => m.id).join(', ')}`;
    patch.openrouterImageModel = match.id;
  }
  updateSettings(patch);
  activity('settings', { message: `Image model set to ${config.openrouter.imageModel}` });
  return `Switched. Pictures are now made with ${currentImageModel()}.`;
}

async function voiceEngine(args) {
  const { kokoroVoices } = await import('./voice/kokoro.js');
  return changeVoice(args, { config, updateSettings, voices: kokoroVoices, activity, xttsVoices: xttsSamples, prepareXTTS: loadXTTS });
}

async function avatarMode({ action }) {
  if (action === 'on' || action === 'off') {
    updateSettings({ avatarVideo: action === 'on' });
    activity('settings', { message: `Avatar mode (video replies) turned ${action}` });
  }
  const on = config.avatarVideo;
  if (!on) return `Avatar mode is off: replies are text only.`;
  if (recorderConnected()) return `Avatar mode is on: Discord text replies also get a video of you saying them.`;
  // No page open: start the hidden one now, so the first clip doesn't wait for it.
  ensureRecorder().catch(() => {});
  return `Avatar mode is on: Discord text replies also get a video of you saying them. The recorder runs by itself in the background (nobody needs to open anything); the first clip can take a little longer while it starts. Videos come with replies in text channels and with post_message posts, not in voice.`;
}

// Pushes wait for the owner: the first push call only previews and remembers it here. It goes
// through on a later turn, within 10 minutes, if the owner's own message says yes and nothing
// new was committed in between. The model can't confirm for them.
const pendingPushes = new Map(); // conversation -> { plan, turn, at }
const YES = /\b(yes|yeah|yep|yup|sure|confirm(ed)?|go ahead|do it|push it|send it|ship it|ok(ay)?)\b/i;
const NO = /\b(no|nope|don'?t|do not|wait|hold on|hold off|cancel|stop|not yet)\b/i;
async function gitAction({ action, repo, files, staged, message, name, title, body, public: isPublic }, ctx) {
  if (action === 'repos') return git.repos();
  if (action === 'clone') return git.clone(name || repo, name ? repo : '');
  if (action === 'create_repo') {
    if (!name) return 'Error: give the new repository a name.';
    const out = await git.createRepo(name, { description: body, isPublic, folder: repo });
    activity('git', { create_repo: name, public: Boolean(isPublic) });
    return out;
  }
  const dir = await git.repoOf(repo);
  if (action === 'pull') return git.pull(dir);
  if (action === 'prs') return git.prs(dir);
  if (action === 'create_pr') return git.createPr(dir, { title, body });
  if (action === 'issues') return git.issues(dir);
  if (action === 'create_issue') return git.createIssue(dir, { title, body });
  if (action === 'status') return git.status(dir);
  if (action === 'diff') return git.diff(dir, { file: Array.isArray(files) ? files[0] : files, staged });
  if (action === 'add') {
    if (!files || (Array.isArray(files) && !files.length)) return 'Error: say which files to add, or ["all"].';
    return git.add(dir, files);
  }
  if (action === 'commit') return git.commit(dir, message);
  if (action !== 'push') return `Error: unknown action "${action}"`;

  const pending = pendingPushes.get(ctx.conversation);
  const confirmed = pending && pending.turn !== ctx.turn && Date.now() - pending.at < 10 * 60_000 && YES.test(ctx.userText ?? '') && !NO.test(ctx.userText ?? '');
  if (confirmed) {
    pendingPushes.delete(ctx.conversation);
    const now = await git.preparePush(dir);
    if (now.repo !== pending.plan.repo || now.branch !== pending.plan.branch || now.commits !== pending.plan.commits) {
      pendingPushes.set(ctx.conversation, { plan: now, turn: ctx.turn, at: Date.now() });
      return `Error: what would be pushed changed since you asked. New preview: ${preview(now)} Ask them to confirm again.`;
    }
    const result = await git.push(now);
    activity('git', { push: `${now.branch} -> ${now.remote}`, repo: dir });
    return result;
  }
  const plan = await git.preparePush(dir);
  pendingPushes.set(ctx.conversation, { plan, turn: ctx.turn, at: Date.now() });
  return `Not pushed yet. ${preview(plan)} Tell your owner exactly this and ask them to confirm; push only goes through after they say yes.`;
}
const preview = (p) =>
  `Ready to push branch ${p.branch} to ${p.remote} (${p.url})${p.upstream ? '' : ', creating it there for the first time'}. Commits:\n${p.commits || '(none)'}\n`;

// Model names as people say them ("grok 4.20", "Claude Opus") against ids like "x-ai/grok-4.20":
// compared without spaces or punctuation, over the id and the display name. Best first: an exact
// id, then the id ending with it, then the name, then anything containing it; shorter wins ties,
// so "kimi" picks the plain model over ":free" or ":batch" variants.
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function matchModels(options, said) {
  const w = squash(said);
  if (!w) return [];
  const score = ({ id, name }) => {
    const i = squash(id), tail = squash(id.split('/').pop()), n = squash(name);
    if (i === w || tail === w) return 0;
    if (tail.startsWith(w) || n.endsWith(w)) return 1;
    if (n.includes(w)) return 2;
    if (i.includes(w)) return 3;
    return -1;
  };
  return options
    .map((o) => ({ ...o, s: score(o) }))
    .filter((o) => o.s >= 0 && !o.id.startsWith('~'))
    .sort((a, b) => a.s - b.s || a.id.length - b.id.length)
    .map((o) => o.id);
}
// When nothing matches: ids sharing the most words with what was said.
function closestModels(options, said) {
  const words = String(said).toLowerCase().split(/[^a-z0-9.]+/).filter((x) => x.length > 1);
  return options
    .map((o) => ({ id: o.id, hits: words.filter((x) => `${o.id} ${o.name}`.toLowerCase().includes(x)).length }))
    .filter((o) => o.hits)
    .sort((a, b) => b.hits - a.hits || a.id.length - b.id.length)
    .slice(0, 6)
    .map((o) => o.id);
}

// The last numbered model list shown in each conversation, so "go with 2" means something.
const lastModelList = new Map();
async function showModels({ purpose = 'coding', count, search }, ctx) {
  let picks, title;
  if (typeof search === 'string' && search.trim()) {
    // The whole catalog, not the ranked slice: every word said must appear in the id or name.
    const words = search.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
    const all = (await openRouterModels()).filter((m) => m.tools && !m.image && !m.id.startsWith('~'));
    picks = all
      .filter((m) => words.every((w) => squash(`${m.id} ${m.name}`).includes(squash(w))))
      .sort((a, b) => b.created - a.created)
      .slice(0, Math.min(15, Math.max(1, Number(count) || 10)));
    if (!picks.length) return `No OpenRouter model (that can use tools) matches "${search}". ${closestModels(all, search).length ? `Closest: ${closestModels(all, search).join(', ')}.` : ''}`;
    title = `OpenRouter models matching "${search}", newest first`;
  } else {
    picks = await rankModels(purpose, Math.min(8, Math.max(1, Number(count) || 5)));
    if (!picks.length) return 'Error: no models came back from OpenRouter.';
    title = `Best ${purpose} models on OpenRouter right now`;
  }
  lastModelList.set(ctx.conversation, picks.map((m) => m.id));
  const current = config.brain === 'openrouter' ? config.openrouter.model : null;
  return (
    `${title} (price per million tokens in/out):\n` +
    picks.map((m, i) => `${i + 1}. ${m.name} (${m.id}) - $${m.price.toFixed(2)}/$${m.outPrice.toFixed(2)}, ${Math.round(m.context / 1000)}k context${m.reasoning ? ', reasoning' : ''}${m.id === current ? ' [current]' : ''}`).join('\n') +
    `\nPresent these as a numbered list and ask which number they want. When they pick one, call switch_brain with pick set to that number.`
  );
}

// Helpers get the tools that make sense unattended: files, web search, reading her own code.
const HELPER_TOOLS = ['files', 'web_search', 'read_source', 'send_file', 'send_project', 'system_info'];
const MAX_HELPERS = 4; // background helpers running at once
async function backgroundTask({ action, title, instructions, model, id, start }, ctx) {
  if (action === 'status') {
    if (id) return taskReport(id, start) ?? `Error: no task #${id}.`;
    const all = listTasks();
    return all.length ? JSON.stringify(all) : 'No background tasks yet.';
  }
  if (action === 'cancel') return cancelTask(id) ? `Cancelling task #${id}.` : `Error: no running task #${id}.`;
  if (!instructions?.trim()) return 'Error: the helper needs instructions.';
  // Several helpers may run at once (start can be called more than once per reply), within a cap,
  // and the same brief twice is one helper, not two.
  const running = runningHelpers();
  const same = running.find((t) => t.brief === instructions.trim());
  if (same) return `Background task #${same.id} "${same.title}" is already working on that brief. Don't start it again.`;
  if (running.length >= MAX_HELPERS) return `Error: ${MAX_HELPERS} helpers are already running (${running.map((t) => `#${t.id} "${t.title}"`).join(', ')}). Wait for one to finish or cancel one first.`;
  const helperCtx = { ...ctx, helper: true, perms: { ...ctx.perms }, sendHere: ctx.sendBackground || ctx.sendHere };
  const tools = HELPER_TOOLS.map((n) => TOOLS[n]).filter((t) => t.enabled(helperCtx)).map((t) => t.definition);
  const task = startTask({
    title,
    conversation: ctx.conversation,
    instructions,
    model: typeof model === 'string' && model.trim() ? model.trim() : config.openrouter.model,
    tools,
    run: (name, args) => (HELPER_TOOLS.includes(name) ? runTool(name, args, helperCtx) : `Error: helpers can't use ${name}`),
    notify: ctx.notify,
    progress: ctx.progress,
  });
  return `Started background task #${task.id} "${task.title}" on ${task.model}. It works on its own and ${ctx.notify ? 'will report back here when done' : 'you can check on it by asking for its status'}. Tell them briefly.`;
}

// Kicks off the history read in the background; she answers straight away.
async function startRebuild({ fresh, this_conversation_only }, ctx) {
  const run = rebuildMemories({ fresh: fresh === true, only: this_conversation_only ? ctx.conversation : null });
  if (!run.started) return `Error: ${run.message}`;
  return `Started reading ${run.conversations} conversation${run.conversations === 1 ? '' : 's'} to rebuild your memories${fresh ? ', after clearing the old ones' : ''}. It runs in the background and takes a few minutes; the dashboard's activity feed shows when it's done. Strangers aren't remembered, only guests, friends and the owner. Tell them briefly.`;
}

// Her own code, read-only. Secrets and private data are never readable: .env (keys and tokens),
// data/ (database, memories, settings), dependencies and git internals.
const SOURCE_BLOCKED = /^(\.env|data|models|node_modules|\.git|\.claude|package-lock\.json)(\/|$)|(^|\/)\.env(\.|$)|\.(db|db-wal|db-shm|glb|png|jpe?g|zip)$/i;
const MAX_SOURCE_CHARS = 60_000; // per file
const MAX_SOURCE_CALL_CHARS = 160_000; // per call, across all its files
function sourceFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (SOURCE_BLOCKED.test(p)) continue;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), p));
    else out.push(p);
  }
  return out;
}
// Each file gets its own budget (one big file used to eat the whole call and leave the rest as
// "first 0 of N characters", which read like a successful read). A file cut short says so loudly,
// with the line to continue from; files past the call's overall limit are named as not read.
async function readSource({ paths, path: one, start_line } = {}) {
  const files = sourceFiles();
  const wanted = (Array.isArray(paths) ? paths : [paths ?? one]).filter((p) => typeof p === 'string' && p.trim()).slice(0, 8);
  if (!wanted.length) return `Your source files:\n${files.join('\n')}`;
  const from = Math.max(1, Number(start_line) || 1);
  let callLeft = MAX_SOURCE_CALL_CHARS;
  const parts = [];
  for (const want of wanted) {
    const rel = want.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
    if (rel.split('/').includes('..') || SOURCE_BLOCKED.test(rel)) {
      parts.push(`${rel}: private, can't be read.`);
      continue;
    }
    if (!files.includes(rel)) {
      const near = files.filter((f) => f.endsWith(`/${rel}`) || f.includes(rel)).slice(0, 5);
      parts.push(`${rel}: no such file.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
      continue;
    }
    if (callLeft < 2000) {
      parts.push(`${rel}: NOT READ, this call's limit was used up by the files before it. Read it in a separate call.`);
      continue;
    }
    const source = readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = source.split(/\r?\n/);
    const total = source.length;
    const cap = Math.min(MAX_SOURCE_CHARS, callLeft);
    let out = '', n = from;
    for (; n <= lines.length; n++) {
      const line = `${n}| ${lines[n - 1]}\n`;
      if (out.length + line.length > cap) break;
      out += line;
    }
    callLeft -= out.length;
    const last = n - 1;
    parts.push(
      last < lines.length
        ? `${rel} TRUNCATED: showing lines ${from}-${last} of ${lines.length} (${out.length} of ~${total} characters). Read the rest with paths ["${rel}"] and start_line ${last + 1}.\n${out}`
        : `${rel} (lines ${from}-${lines.length} of ${lines.length}, complete, ${out.length} characters):\n${out}`,
    );
  }
  return parts.join('\n\n----\n\n');
}

// Several files zipped into one attachment. The unpacked project is kept in data/projects/<name>.
const MAX_PROJECT_FILES = 200;
async function sendProject({ name, files, recipient, message }, ctx) {
  if (!Array.isArray(files) || !files.length) return 'Error: the project has no files';
  if (files.length > MAX_PROJECT_FILES) return `Error: too many files (${files.length}); the limit is ${MAX_PROJECT_FILES}`;
  const project = safeFilename(name).replace(/\.[a-z0-9]+$/i, '') || 'project';
  const entries = new Map();
  for (const f of files) {
    if (typeof f?.content !== 'string') continue;
    const rel = safePath(f.path);
    if (rel) entries.set(rel, Buffer.from(f.content, 'utf8')); // a repeated path: the last one wins
  }
  if (!entries.size) return 'Error: none of the files had a usable path and content';
  const list = [...entries].map(([p, data]) => ({ path: `${project}/${p}`, data }));
  const archive = zip(list);
  if (archive.length > MAX_FILE_BYTES) return `Error: the project is too big to send (${(archive.length / 1048576).toFixed(1)} MB)`;

  const dir = path.join(DATA_DIR, 'projects', project);
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), data);
  }
  const result = await deliver(`${project}.zip`, archive, { recipient, message }, ctx);
  return result.startsWith('Error') ? result : `${result} (${entries.size} files: ${[...entries.keys()].join(', ')})`;
}

// A relative path inside a project: forward slashes, no "..", no drive letters or leading slash.
function safePath(p) {
  const parts = String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[^\w.\- ]+/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/').slice(0, 200);
}

function safeFilename(filename) {
  const name = String(filename ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .slice(0, 100);
  if (!name || name.startsWith('.')) return `file${name || '.txt'}`;
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.txt`;
}

function setTier({ person, tier, reason = '', owner_instruction: ownerSaid = false }, ctx = {}) {
  if (!TIERS[tier]) return `Error: tier must be one of ${Object.keys(TIERS).join(', ')}`;
  const contact = findContact(person);
  if (!contact) return `Error: "${person}" isn't on your contact list. They need to talk to you at least once first.`;
  const before = contact.tier;
  if (before === tier) return `${contact.name} was already a ${tier}.`;
  const forced = Boolean(ownerSaid && ctx.perms?.owner);
  if (!forced) {
    const refusal = tierMoveRefusal(contact, tier, ctx);
    if (refusal) return refusal;
  }
  setContactTier(contact.user_id, tier);
  noteTierMove(contact.user_id, { from: before, to: tier, reason, by: forced ? 'owner' : 'her' });
  activity('contact', { name: contact.name, userId: contact.user_id, from: before, tier, reason, by: forced ? 'owner' : 'her' });
  return before === tier ? `${contact.name} was already a ${tier}.` : `${contact.name} is now a ${tier} (was ${before}).`;
}

function showContacts({ tier } = {}) {
  const rows = listContacts()
    .map((c) => ({ ...c, tier: tierOf(c.user_id) }))
    .filter((c) => !tier || c.tier === tier);
  if (!rows.length) return tier ? `Nobody is a ${tier}.` : 'Your contact list is empty.';
  return rows
    .map((c) => `- ${c.name}${c.username && c.username !== c.name ? ` (@${c.username})` : ''}: ${c.tier}${c.last_dm_at ? ', has DMed you' : ''}`)
    .join('\n');
}

// The conversation by time (the timeline tool).
function parseWhen(text) {
  const t = String(text || '').trim().toLowerCase();
  const now = new Date();
  const rel = t.match(/(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day)s?\s+ago/);
  if (rel) return Date.now() - Number(rel[1]) * { minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5 }[rel[2]];
  const clock = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!clock) return NaN;
  let h = Number(clock[1]) % 24;
  if (clock[3] === 'pm' && h < 12) h += 12;
  if (clock[3] === 'am' && h === 12) h = 0;
  const d = new Date(now);
  d.setHours(h, Number(clock[2] || 0), 0, 0);
  if (t.includes('yesterday')) d.setDate(d.getDate() - 1);
  else if (d > now) d.setDate(d.getDate() - 1); // "9pm" said in the morning means last night
  return d.getTime();
}

function formatLines(rows) {
  return rows
    .map((m) => `[${new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}] ${m.role === 'assistant' ? m.name ?? config.botName : m.name}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
}

// Documents people sent, opened again for whoever may see them (attachments.js canOpenReceived):
// a DM's file only for its sender and the owner, a channel's for people in that server.
const RECEIVED_PART = 40_000;
export function receivedFile({ name = '', part = 1 } = {}, ctx = {}) {
  const who = { speakerId: ctx.speaker?.id, owner: Boolean(ctx.perms?.owner), guild: ctx.guild?.id ?? null };
  const { open, hidden } = findReceived(String(name || ''), who, receivedFileRows());
  const when = (f) => new Date(f.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const label = (f) => `"${f.name}" from ${f.fromName ?? 'someone'}${f.where ? ` in ${f.where}` : ''}, ${when(f)}`;
  if (!String(name || '').trim()) {
    return open.length ? `Files you can open:\n${open.slice(0, 15).map((f) => `- ${label(f)}${f.image ? ' (a picture)' : ''}`).join('\n')}` : 'Error: no file anyone sent is open to you here.';
  }
  const f = open[0];
  if (!f) return hidden ? `Error: a file matching "${name}" was sent in a DM and is private to whoever sent it; you can't open it for ${ctx.speaker?.name ?? 'them'}.` : `Error: no file matching "${name}" was sent to you. Use name "" to list the ones you can open.`;
  if (f.image) return `${label(f)} is a picture, not a document; you can't look at it again from here. It's saved at ${f.saved}.`;
  const parts = Math.max(1, Math.ceil(f.text.length / RECEIVED_PART));
  const n = Math.min(Math.max(1, Math.floor(Number(part) || 1)), parts);
  const privateNote = f.dm && f.from !== ctx.speaker?.id ? `\n(Sent to you privately by ${f.fromName}: don't share it in front of others unless ${f.fromName} brings it up.)` : '';
  return `${label(f)}${parts > 1 ? `, part ${n} of ${parts}` : ''}:${privateNote}\n<<<\n${f.text.slice((n - 1) * RECEIVED_PART, n * RECEIVED_PART)}\n>>>${n < parts ? `\n[TRUNCATED: part ${n} of ${parts}; call again with part ${n + 1} for more.]` : ''}${open.length > 1 ? `\n(Other matches: ${open.slice(1, 4).map(label).join('; ')}.)` : ''}`;
}

async function timelineLookup({ action, person, time, text, minutes }, ctx) {
  const conv = ctx.conversation;
  const span = (Number(minutes) || 15) * 6e4;
  if (action === 'oldest') {
    const rows = oldestMessages(conv, 15);
    return rows.length ? `The oldest things in this conversation:\n${formatLines(rows)}` : 'This conversation has no saved messages yet.';
  }
  if (action === 'search') {
    if (!String(text || '').trim()) return 'Error: give `text` to search for.';
    const rows = searchMessages(conv, text, 20);
    return rows.length ? formatLines(rows) : `Nothing in this conversation mentions "${text}".`;
  }
  if (action === 'around') {
    const at = parseWhen(time);
    if (Number.isNaN(at)) return `Error: couldn't read the time "${time}". Use something like "3:15 pm", "45 minutes ago" or "yesterday 9pm".`;
    const rows = messagesBetween(conv, at - span / 2, at + span / 2, 60);
    return rows.length ? `Around ${new Date(at).toLocaleString()}:\n${formatLines(rows)}` : `Nothing was said here around ${new Date(at).toLocaleString()}.`;
  }
  const events = presenceEvents({ person: person || undefined }).filter((e) => !conv.startsWith('voice:') || e.conversation === conv);
  if (action === 'joins') {
    const last = events.slice(-25);
    return last.length
      ? last.map((e) => `[${new Date(e.ts).toLocaleString()}] ${e.name} ${e.event === 'join' ? 'joined' : e.event === 'leave' ? 'left' : 'was already in the call when you joined'}`).join('\n')
      : `No voice joins recorded${person ? ` for ${person}` : ''} yet (tracking started with this update).`;
  }
  if (action === 'before_join') {
    if (!String(person || '').trim()) return 'Error: give `person`: whose join to look before.';
    const join = events.filter((e) => e.event === 'join').at(-1);
    if (!join) return `Error: no record of ${person} joining voice yet (joins are tracked from this update on). Try action around with a time instead.`;
    const rows = messagesBetween(join.conversation, join.ts - span, join.ts, 60);
    return rows.length
      ? `${join.name} joined at ${new Date(join.ts).toLocaleString()}. The ${Math.round(span / 6e4)} minutes before that:\n${formatLines(rows)}`
      : `${join.name} joined at ${new Date(join.ts).toLocaleString()}, but nothing was said in the ${Math.round(span / 6e4)} minutes before.`;
  }
  return `Error: unknown action "${action}".`;
}
