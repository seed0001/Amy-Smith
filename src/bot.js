import { noteReceived, readAttachments } from './attachments.js';
import * as presence from './presence.js';
import { spamGuard } from './moderation.js';
import { resumeAfterRestart } from './restart.js';
import { watchMessage } from './protect.js';
import { isOwner } from './contacts.js';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, ChannelType } from 'discord.js';
import { config, updateSettings } from './config.js';
import { loadCommands } from './loadCommands.js';
import { respond, SEARCH_ANNOUNCEMENT, taskCue } from './companion.js';
import { sessions } from './voice/session.js';
import { requestClip } from './avatarVideo.js';
import { activity } from './events.js';
import { replyInFlight } from './busy.js';
import { setPoster, noteChannelActivity } from './thoughts.js';

const commands = await loadCommands();

// Owns the Discord connection so the dashboard can turn the bot on and off without restarting the app.
export const bot = {
  client: null,
  status: 'offline', // offline | starting | online | stopping
  since: Date.now(),
  error: null,

  async start() {
    if (this.client) return;
    this.setStatus('starting');
    const client = createClient();
    this.client = client;
    try {
      await client.login(config.discordToken);
      updateSettings({ botEnabled: true });
    } catch (err) {
      this.client = null;
      client.destroy().catch(() => {});
      this.error = err.message;
      this.setStatus('offline');
      activity('error', { where: 'discord login', message: err.message });
      throw err;
    }
  },

  async stop() {
    if (!this.client) return;
    this.setStatus('stopping');
    for (const session of [...sessions.values()]) session.destroy();
    const client = this.client;
    this.client = null;
    await client.destroy();
    updateSettings({ botEnabled: false });
    this.setStatus('offline');
    activity('power', { message: 'Bot turned off' });
  },

  setStatus(status) {
    this.status = status;
    this.since = Date.now();
    if (status !== 'offline') this.error = null;
  },
};

// Solo thoughts post through this, resolving the configured channel at post time (never at
// startup, and never falling back to a chat channel). The busy check covers text replies and a
// voice session that is speaking or has a reply queued.
setPoster({
  busy: () => replyInFlight() || [...sessions.values()].some((s) => s.speaking || s.pending > 0),
  post: async ({ channelId, content }) => {
    const client = bot.client;
    if (!client) return { posted: false, reason: 'bot_offline' };
    let channel = client.channels.cache.get(channelId);
    if (!channel) channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { posted: false, reason: 'channel_missing' };
    if (channel.type !== ChannelType.GuildText) return { posted: false, reason: 'not_text_channel' };
    const perms = channel.permissionsFor(client.user);
    if (!perms?.has('SendMessages')) return { posted: false, reason: 'no_send_permission' };
    await channel.send({ content, allowedMentions: { parse: [] } });
    return { posted: true, channel: channel.id };
  },
});

function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers, // privileged: needed for speaker names in voice
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.once(Events.ClientReady, (c) => {
    bot.setStatus('online');
    activity('power', { message: `Online as ${c.user.tag} in ${c.guilds.cache.size} server(s)` });
    resumeAfterRestart(c).catch((err) => activity('error', { where: 'resume after restart', message: err.message }));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      activity('error', { where: `/${interaction.commandName}`, message: err.message });
      const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    noteChannelActivity(message.channelId); // any human message, not just in reply channels
    spamGuard(message, isOwner).catch((err) => activity('error', { where: 'spam guard', message: err.message }));
    if (!message.content && !message.attachments.size) return;

    const isDM = message.channel.type === ChannelType.DM;
    const mentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
    const openChannel = config.chatChannelIds.includes(message.channelId);
    // During a live call she keeps an ear on the server's text chat, so in voice she can say what's
    // going on there. That's all: typed messages still get typed replies, never spoken ones.
    const call = message.guild && sessions.get(message.guild.id);
    if (call && !call.destroyed && (message.content || message.attachments.size)) call.noteChat(message);
    // Messages not aimed at her are still read for how people treat each other (and her).
    if (!isDM && !mentioned && !openChannel) {
      if (message.guild && message.content) {
        const recent = [...(await message.channel.messages.fetch({ limit: 6, before: message.id }).catch(() => new Map())).values()].reverse()
          .map((m) => `${m.author.id === client.user.id ? 'you' : m.member?.displayName ?? m.author.username}: ${m.content.slice(0, 200)}`);
        const speaker = { id: message.author.id, name: message.member?.displayName ?? message.author.displayName, username: message.author.username };
        const present = [...new Set(recent.map((l) => l.split(':')[0]))].map((n) => message.guild.members.cache.find((m) => m.displayName === n)).filter(Boolean)
          .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username }));
        watchMessage({ speaker, text: message.content, recent, present, discord: { guild: message.guild, channel: message.channel, voice: call },
          speak: async (cue) => {
            const line = await respond({ conversation: `text:${message.channelId}`, speaker, text: '', cue, discord: { client, guild: message.guild, channel: message.channel } });
            if (line) await message.channel.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } });
          } }).catch((err) => activity('error', { where: 'protect (text)', message: err.message }));
      }
      return;
    }

    let text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text && !message.attachments.size) return;

    const speaker = {
      id: message.author.id,
      name: message.member?.displayName ?? message.author.displayName,
      username: message.author.username,
      dm: isDM,
    };
    const files = []; // attachments the bot makes this turn ride along with its reply
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    message.channel.sendTyping().catch(() => {});

    try {
      // Pictures and documents they sent: saved, read, and handed to her with the message.
      const attachments = message.attachments.size ? await readAttachments(message.attachments) : undefined;
      if (attachments) noteReceived({ attachments, from: speaker.id, fromName: speaker.name, dm: isDM, guild: message.guild?.id ?? null, where: isDM ? 'a DM' : `#${message.channel.name}` });
      if (!text) text = '(sent this without saying anything)';
      const reply = await respond({
        conversation: `text:${message.channelId}`,
        speaker,
        text,
        attachments,
        onSearching: () =>
          message.reply({ content: `🔎 ${SEARCH_ANNOUNCEMENT}`, allowedMentions: { repliedUser: false } }).catch(() => {}),
        // voice: if she's in a voice channel in this server, typed music requests play there.
        discord: {
          client,
          guild: message.guild,
          sendHere: async (file) => files.push(file),
          sendBackground: (file) => message.channel.send({ files: [file], allowedMentions: { parse: [] } }),
          channel: message.channel,
          messageId: message.id,
          voice: message.guild && sessions.get(message.guild.id),
          // Background helpers report back here when they finish, long after this reply. The
          // doctor's report is posted as is; anything else she tells them about in her own words.
          notify: async (text) => {
            const say = (content) => { for (const chunk of splitMessage(content)) message.channel.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {}); };
            if (/^Doctor visit /.test(text)) return say(text);
            const line = await respond({ conversation: `text:${message.channelId}`, speaker, text: '', cue: taskCue(text), evidence: text, discord: { client, guild: message.guild, channel: message.channel } })
              .catch((err) => { activity('error', { where: 'task report reply', message: err.message }); return ''; });
            say(line || text);
          },
          // A short line now and then while a helper works, so it's never silent for long.
          progress: (text) => message.channel.send({ content: `⏳ ${text}`, allowedMentions: { parse: [] } }).catch(() => {}),
        },
      });
      clearInterval(typing);
      const chunks = splitMessage(reply || '…');
      const last = chunks.length - 1;
      // A clip of her saying it, if the recorder page is open. The text goes out now regardless;
      // the clip is added to the same message when (and if) it arrives.
      const clip = reply ? requestClip(reply) : Promise.resolve(null);
      if (call && !call.destroyed && reply) call.noteChat({ channel: message.channel, author: { displayName: 'you' }, content: reply });
      const first = await message.reply({ content: chunks[0], files: last === 0 ? files : [], allowedMentions: { repliedUser: false, parse: [] } });
      clip.then((video) => video && first.edit({ files: [{ attachment: video, name: 'reply.webm' }] })).catch((err) => activity('error', { where: 'video reply', message: err.message }));
      for (const [i, chunk] of chunks.slice(1).entries()) {
        await message.channel.send({ content: chunk, files: i + 1 === last ? files : [], allowedMentions: { parse: [] } });
      }
    } catch (err) {
      clearInterval(typing);
      activity('error', { where: 'text reply', message: err.message });
      await message.reply('My brain glitched for a sec, try again?').catch(() => {});
    }
  });

  // Leave voice when everyone else has left.
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const session = sessions.get(oldState.guild.id);
    if (!session) return;
    // Someone joined her channel: an intro if they've never met her, plus anything she owes them.
    if (newState.channelId === session.channelId && oldState.channelId !== session.channelId && newState.member) session.arrived([newState.member]);
    if (oldState.channelId !== session.channelId) return;
    if (newState.channelId !== session.channelId) presence.left(session.conversation, oldState.id);
    const channel = oldState.guild.channels.cache.get(session.channelId);
    if (channel && !channel.members.some((m) => !m.user.bot)) session.destroy();
  });

  return client;
}

function splitMessage(text, max = 2000) {
  const chunks = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max / 2) cut = text.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  chunks.push(text);
  return chunks;
}
