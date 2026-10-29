import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

// Server management for the owner (the moderate tool): timeout, warnings, kick, ban, channel and
// role creation/deletion, message clean-up, slowmode, invites, and a basic spam guard. Kicks are
// two-step: the first ask gives the member one warning (by DM, or in-channel if their DMs are
// closed), and only a later ask, after that warning, actually removes them. Every action, including
// the spam guard's, is one line in data/moderation.jsonl with the time, who asked, the target, and
// the reason.

const LOG = path.join(DATA_DIR, 'moderation.jsonl');
const WARN_FILE = path.join(DATA_DIR, 'warnings.json');

// A warning goes stale after this long, so a kick months later can't ride on an old warning.
const WARN_TTL_MS = 30 * 864e5;

function readWarnings() {
  if (!existsSync(WARN_FILE)) return {};
  try {
    return JSON.parse(readFileSync(WARN_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function writeWarnings(all) {
  try {
    writeFileSync(`${WARN_FILE}.tmp`, JSON.stringify(all, null, 2));
    renameSync(`${WARN_FILE}.tmp`, WARN_FILE);
  } catch {}
}

// The one active warning for this member in this server, or null (expired ones are dropped).
export function warningsFor(guildId, userId) {
  const all = readWarnings();
  const key = `${guildId}:${userId}`;
  const warning = all[key];
  if (!warning) return null;
  if (Date.now() - warning.ts > WARN_TTL_MS) {
    delete all[key];
    writeWarnings(all);
    return null;
  }
  return warning;
}

function warningCount(guildId) {
  const all = readWarnings();
  return Object.entries(all).filter(
    ([k, w]) => k.startsWith(`${guildId}:`) && Date.now() - w.ts <= WARN_TTL_MS,
  ).length;
}

// Delivers Amy's one warning by DM, falling back to the channel when their DMs are closed. The
// warning is recorded either way: if she couldn't reach them, the next ask still kicks.
export async function deliverWarning(guild, member, reason, by, here) {
  const why = String(reason || '').trim() || 'what you have been doing';
  const sentence = why.replace(/[.!?\s]+$/, '');
  const text = `Hey ${member.displayName} — this is your one warning. ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. If you keep this up, I'm going to kick you from ${guild.name}.`;
  const key = `${guild.id}:${member.id}`;
  const dm = await member.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
  let where = dm ? 'dm' : 'none';
  if (!dm && here?.isTextBased?.()) {
    const sent = await here.send({ content: `<@${member.id}> ${text}`, allowedMentions: { users: [member.id] } }).catch(() => null);
    if (sent) where = 'channel';
  }
  const all = readWarnings();
  all[key] = { name: member.displayName, reason: why, by, ts: Date.now(), delivery: where };
  writeWarnings(all);
  if (where === 'dm') return { where, note: 'by DM' };
  if (where === 'channel') return { where, note: `in #${here.name}` };
  return { where, note: "(though I couldn't actually reach them: their DMs are closed and I couldn't post here)" };
}

export function clearWarning(guildId, userId) {
  const all = readWarnings();
  delete all[`${guildId}:${userId}`];
  writeWarnings(all);
}

export function logAction(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  try {
    appendFileSync(LOG, JSON.stringify(line) + '\n');
  } catch {}
  activity('moderation', line);
}

export function recentActions(limit = 15) {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
}

// A member by @mention, id, display name or username (exact first, then partial).
export async function findMember(guild, who) {
  const want = String(who ?? '').trim().replace(/^<@!?(\d+)>$/, '$1');
  if (!want) return null;
  if (/^\d{15,}$/.test(want)) return guild.members.fetch(want).catch(() => null);
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const lower = want.toLowerCase();
  const names = (m) => [m.displayName, m.user.username, m.user.globalName].filter(Boolean).map((n) => n.toLowerCase());
  return members.find((m) => names(m).includes(lower)) ?? members.find((m) => names(m).some((n) => n.includes(lower))) ?? null;
}

function findChannel(guild, name, fallback) {
  const want = String(name ?? '').trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').toLowerCase();
  if (!want) return fallback;
  return guild.channels.cache.find((c) => c.id === want || c.name.toLowerCase() === want) ?? null;
}

function findRole(guild, name) {
  const want = String(name ?? '').trim().replace(/^<@&(\d+)>$/, '$1').replace(/^@/, '').toLowerCase();
  return guild.roles.cache.find((r) => r.id === want || r.name.toLowerCase() === want) ?? null;
}

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  forum: ChannelType.GuildForum,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
};

function typeName(type) {
  const names = {
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildCategory]: 'category',
    [ChannelType.GuildAnnouncement]: 'announcement',
    [ChannelType.GuildForum]: 'forum',
    [ChannelType.GuildStageVoice]: 'stage',
  };
  return names[type] ?? 'channel';
}

function channelsSorted(guild) {
  return [...guild.channels.cache.values()].sort((a, b) => a.position - b.position);
}

function findCategory(guild, name) {
  const want = String(name ?? '').trim().replace(/^#/, '').toLowerCase();
  return (
    guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && (c.id === want || c.name.toLowerCase() === want),
    ) ?? null
  );
}

function channelSlug(name, type = ChannelType.GuildText) {
  const base = String(name ?? '').trim().replace(/^#/, '');
  // Voice, stage and category names may keep their spaces and capitals; text-ish ones get slugged.
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory].includes(type)) {
    return base.slice(0, 100);
  }
  return base.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 100);
}

const isTrue = (v) => v === true || v === 'true';

// args: { action, user, channel, role, minutes, count, reason, message_id, name, type, category,
// topic, color, hoist, mentionable, force }. ctx: tool context (guild, the channel she's talking in,
// the speaker). Returns a plain message; errors start with "Error:".
export async function moderate(args, ctx) {
  const {
    action, user, channel, role, minutes, count, reason, message_id,
    name, type, category, topic, color, hoist, mentionable, force,
  } = args;
  if (action === 'log') {
    const rows = recentActions(Number(count) || 15);
    return rows.length ? rows.map((r) => `${r.ts.slice(0, 16).replace('T', ' ')} ${r.action}${r.target ? ` ${r.target}` : ''}${r.channel ? ` #${r.channel}` : ''} by ${r.by}: ${r.reason}`).join('\n') : 'No moderation actions logged yet.';
  }

  const guild = ctx.guild ?? ctx.client?.guilds.cache.first();
  if (!guild) return 'Error: no server here to moderate (this is a DM). Ask in the server.';
  const me = guild.members.me;
  const reasonGiven = String(reason ?? '').trim();
  const why = reasonGiven || 'no reason given';
  const by = ctx.speaker?.name ?? 'owner';
  const here = ctx.channel ?? (ctx.channelId ? guild.channels.cache.get(ctx.channelId) : null);
  const done = (summary, extra = {}) => {
    logAction({ action, by, guild: guild.name, reason: why, ...extra });
    return summary;
  };
  const need = (perm, label) => (me.permissions.has(perm) ? null : `Error: I don't have the "${label}" permission in ${guild.name}. Give my role that permission in Server Settings, then try again.`);

  if (action === 'warnings') {
    const all = readWarnings();
    const member = user ? await findMember(guild, user) : null;
    if (user && !member) return `Error: couldn't find "${user}" in ${guild.name}.`;
    const rows = Object.entries(all)
      .filter(([key]) => key.startsWith(`${guild.id}:`) && (!member || key === `${guild.id}:${member.id}`))
      .map(([, w]) => w)
      .filter((w) => Date.now() - w.ts <= WARN_TTL_MS);
    if (!rows.length) return `No active warnings in ${guild.name}.`;
    return rows
      .map((w) => `${w.name}: warned ${new Date(w.ts).toISOString().slice(0, 10)} by ${w.by} — ${w.reason}`)
      .join('\n');
  }

  if (action === 'server_info') {
    const channels = guild.channels.cache;
    const kind = (t) => (t === ChannelType.GuildCategory ? 'categories' : t === ChannelType.GuildVoice ? 'voice' : 'text');
    const tally = { text: 0, voice: 0, categories: 0 };
    for (const c of channels.values()) tally[kind(c.type)]++;
    return [
      `${guild.name} (${guild.id})`,
      `Owner: <@${guild.ownerId}> · ${guild.memberCount} members · created ${guild.createdAt.toDateString()}`,
      `${tally.text} text, ${tally.voice} voice, ${tally.categories} categories · ${guild.roles.cache.size} role${guild.roles.cache.size === 1 ? '' : 's'} · ${warningCount(guild.id)} active warning(s)`,
      `Boost level ${guild.premiumTier}${guild.premiumSubscriptionCount ? ` (${guild.premiumSubscriptionCount} boosts)` : ''}`,
    ].join('\n');
  }

  if (action === 'list_channels') {
    const lines = [];
    for (const cat of channelsSorted(guild).filter((c) => c.type === ChannelType.GuildCategory)) {
      lines.push(`${cat.name}`);
      for (const c of channelsSorted(guild).filter((x) => x.parentId === cat.id)) lines.push(`  #${c.name} (${typeName(c.type)})`);
    }
    const loose = channelsSorted(guild).filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory);
    if (loose.length) lines.push('(no category)', ...loose.map((c) => `  #${c.name} (${typeName(c.type)})`));
    return lines.join('\n') || 'No channels.';
  }

  if (action === 'create_channel') {
    if (need(PermissionFlagsBits.ManageChannels, 'Manage Channels')) return need(PermissionFlagsBits.ManageChannels, 'Manage Channels');
    const channelType = String(type || 'text').toLowerCase();
    const typeId = CHANNEL_TYPES[channelType];
    if (typeId === undefined) return `Error: unknown channel type "${type}". Use text, voice, category, forum, announcement or stage.`;
    const channelName = channelSlug(name || channel, typeId);
    if (!channelName) return 'Error: what should the channel be called? Put the name in `name`.';
    const parent = category && typeId !== ChannelType.GuildCategory ? findCategory(guild, category) : null;
    if (category && !parent) return `Error: there's no category called "${category}".`;
    const created = await guild.channels.create({
      name: channelName,
      type: typeId,
      ...(parent ? { parent: parent.id } : {}),
      ...(topic && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(typeId) ? { topic: String(topic) } : {}),
      reason: why,
    });
    return done(`Created ${typeName(typeId)} ${typeId === ChannelType.GuildCategory ? created.name : `#${created.name}`}${parent ? ` under ${parent.name}` : ''}.`, { channel: created.name });
  }

  if (action === 'delete_channel') {
    if (need(PermissionFlagsBits.ManageChannels, 'Manage Channels')) return need(PermissionFlagsBits.ManageChannels, 'Manage Channels');
    const target = findChannel(guild, channel, here);
    if (!target) return `Error: couldn't find a channel called "${channel || '(this one)'}".`;
    if (target.id === here?.id && !isTrue(force)) return `Error: I can't delete the channel we're talking in — my reply would have nowhere to go. Ask me from another channel, or pass force true if you really mean it.`;
    const label = target.type === ChannelType.GuildCategory ? target.name : `#${target.name}`;
    await target.delete(why);
    return done(`Deleted ${label}.`, { channel: target.name });
  }

  if (action === 'edit_channel') {
    if (need(PermissionFlagsBits.ManageChannels, 'Manage Channels')) return need(PermissionFlagsBits.ManageChannels, 'Manage Channels');
    const target = findChannel(guild, channel, here);
    if (!target) return `Error: couldn't find a channel called "${channel || '(this one)'}".`;
    const changes = [];
    const newName = channelSlug(name, target.type);
    if (newName) {
      await target.setName(newName, why);
      changes.push(`renamed to #${newName}`);
    }
    if (topic) {
      if (!target.isTextBased?.()) return `Error: ${target.name} can't have a topic.`;
      await target.setTopic(String(topic), why);
      changes.push(`topic set to "${topic}"`);
    }
    if (!changes.length) return 'Error: what should change? Give me a new `name` or `topic`.';
    return done(`Updated ${target.name}: ${changes.join(', ')}.`, { channel: target.name });
  }

  if (action === 'create_role') {
    if (need(PermissionFlagsBits.ManageRoles, 'Manage Roles')) return need(PermissionFlagsBits.ManageRoles, 'Manage Roles');
    const roleName = String(name || role || '').trim();
    if (!roleName) return 'Error: what should the role be called? Put the name in `name`.';
    const rgb = /^#?[0-9a-f]{6}$/i.test(String(color || '').trim()) ? Number.parseInt(String(color).replace('#', ''), 16) : undefined;
    const created = await guild.roles.create({
      name: roleName,
      ...(rgb !== undefined ? { color: rgb } : {}),
      hoist: isTrue(hoist),
      mentionable: isTrue(mentionable),
      reason: why,
    });
    return done(`Created role ${created.name}.`, { role: created.name });
  }

  if (action === 'delete_role') {
    if (need(PermissionFlagsBits.ManageRoles, 'Manage Roles')) return need(PermissionFlagsBits.ManageRoles, 'Manage Roles');
    const target = findRole(guild, role);
    if (!target) return `Error: there's no role called "${role}".`;
    if (target.id === guild.id) return "Error: I can't delete @everyone.";
    if (target.managed) return `Error: ${target.name} is managed by an integration or bot, so Discord won't let me delete it.`;
    if (target.position >= me.roles.highest.position) return `Error: the ${target.name} role is above mine, so I can't delete it.`;
    await target.delete(why);
    return done(`Deleted role ${target.name}.`, { role: target.name });
  }

  if (action === 'create_invite') {
    if (need(PermissionFlagsBits.CreateInstantInvite, 'Create Invite')) return need(PermissionFlagsBits.CreateInstantInvite, 'Create Invite');
    const target = findChannel(guild, channel, here);
    if (!target?.isTextBased?.()) return `Error: I can only make invites for text channels; "${channel || '(this one)'}" isn't one.`;
    const invite = await target.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: why });
    return done(`Made an invite to #${target.name}: ${invite.url}`, { channel: target.name, invite: invite.url });
  }

  if (action === 'edit_server') {
    if (need(PermissionFlagsBits.ManageGuild, 'Manage Server')) return need(PermissionFlagsBits.ManageGuild, 'Manage Server');
    const newName = String(name || '').trim();
    if (!newName) return 'Error: what should the server be renamed to? Put it in `name`.';
    const before = guild.name;
    await guild.setName(newName, why);
    return done(`Renamed the server from ${before} to ${newName}.`, {});
  }

  if (['timeout', 'untimeout', 'warn', 'kick', 'ban', 'add_role', 'remove_role'].includes(action) || action?.startsWith('voice_')) {
    const member = await findMember(guild, user);
    if (!member) return `Error: couldn't find "${user}" in ${guild.name}. Use their exact name or @mention.`;
    if (member.id === me.id) return "Error: that's me.";
    if (member.id === guild.ownerId) return `Error: ${member.displayName} owns the server; Discord won't let anyone moderate the owner.`;
    const target = member.displayName;
    if (['warn', 'kick', 'ban'].includes(action) && !reasonGiven) {
      return `Error: what did ${target} do? Give me a reason so I can tell them and log it.`;
    }
    if (action === 'warn') {
      const delivery = await deliverWarning(guild, member, reasonGiven, by, here);
      return done(`Warned ${target} ${delivery.note}: "${reasonGiven}". That's their one warning; if they keep it up, say kick again and it goes through.`, { target, delivery: delivery.where });
    }
    if (action === 'timeout' || action === 'untimeout') {
      if (need(PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return need(PermissionFlagsBits.ModerateMembers, 'Timeout Members');
      if (!member.moderatable) return `Error: ${target}'s role is above mine, so I can't time them out. Move my role higher.`;
      if (action === 'untimeout') {
        await member.timeout(null, why);
        return done(`Took ${target} out of timeout.`, { target });
      }
      const mins = Math.min(Math.max(Number(minutes) || 10, 1), 40320); // Discord's max is 28 days
      await member.timeout(mins * 60000, why);
      return done(`Timed out ${target} for ${mins} minute${mins === 1 ? '' : 's'}.`, { target, minutes: mins });
    }
    // Voice: disconnect, server mute/deafen (for everyone, not just her), and moving between channels.
    if (action.startsWith('voice_')) {
      const perm = { voice_disconnect: [PermissionFlagsBits.MoveMembers, 'Move Members'], voice_move: [PermissionFlagsBits.MoveMembers, 'Move Members'], voice_mute: [PermissionFlagsBits.MuteMembers, 'Mute Members'], voice_unmute: [PermissionFlagsBits.MuteMembers, 'Mute Members'], voice_deafen: [PermissionFlagsBits.DeafenMembers, 'Deafen Members'], voice_undeafen: [PermissionFlagsBits.DeafenMembers, 'Deafen Members'] }[action];
      if (!perm) return `Error: unknown voice action "${action}".`;
      if (need(...perm)) return need(...perm);
      const voice = member.voice;
      // Mutes and deafens stick to the member even out of voice, but Discord only lets you set them while they're in a call.
      if (!voice?.channel) return `Error: ${target} isn't in a voice channel right now.`;
      const from = voice.channel.name;
      if (action === 'voice_disconnect') {
        await voice.disconnect(why);
        return done(`Disconnected ${target} from ${from}.`, { target, channel: from });
      }
      if (action === 'voice_move') {
        const want = String(channel ?? '').trim().replace(/^#/, '').toLowerCase();
        const voiceChannels = guild.channels.cache.filter((c) => c.isVoiceBased());
        const to = voiceChannels.find((c) => c.id === want || c.name.toLowerCase() === want) ?? voiceChannels.find((c) => want && c.name.toLowerCase().includes(want));
        if (!to) return `Error: no voice channel called "${channel}". Voice channels: ${voiceChannels.map((c) => c.name).join(', ') || 'none'}.`;
        if (to.id === voice.channelId) return `${target} is already in ${to.name}.`;
        await voice.setChannel(to, why);
        return done(`Moved ${target} from ${from} to ${to.name}.`, { target, channel: to.name, from });
      }
      const on = !action.startsWith('voice_un');
      if (action.endsWith('mute')) await voice.setMute(on, why);
      else await voice.setDeaf(on, why);
      const verb = { voice_mute: 'Server-muted', voice_unmute: 'Unmuted', voice_deafen: 'Server-deafened', voice_undeafen: 'Undeafened' }[action];
      return done(`${verb} ${target} in ${from}${on ? ' (for everyone, until someone undoes it)' : ''}.`, { target, channel: from });
    }
    if (action === 'kick') {
      const pending = warningsFor(guild.id, member.id);
      // One warning first. Only a later ask, with that warning on record, actually kicks.
      if (!pending && !isTrue(force)) {
        const delivery = await deliverWarning(guild, member, reasonGiven, by, here);
        logAction({ action: 'warn', by, guild: guild.name, reason: why, target, delivery: delivery.where, requested: 'kick' });
        return `Gave ${target} their one warning ${delivery.note} instead of kicking: "${reasonGiven}". If they keep it up, say kick again and it goes through.`;
      }
      if (need(PermissionFlagsBits.KickMembers, 'Kick Members')) return need(PermissionFlagsBits.KickMembers, 'Kick Members');
      if (!member.kickable) return `Error: ${target}'s role is above mine, so I can't kick them.`;
      await member.kick(why);
      clearWarning(guild.id, member.id);
      const warnedOn = pending ? ` after their warning on ${new Date(pending.ts).toISOString().slice(0, 10)}` : '';
      return done(`Kicked ${target}${warnedOn}.`, { target, after_warning: Boolean(pending) });
    }
    if (action === 'ban') {
      if (need(PermissionFlagsBits.BanMembers, 'Ban Members')) return need(PermissionFlagsBits.BanMembers, 'Ban Members');
      if (!member.bannable) return `Error: ${target}'s role is above mine, so I can't ban them.`;
      await member.ban({ reason: why, deleteMessageSeconds: 0 });
      clearWarning(guild.id, member.id);
      return done(`Banned ${target}.`, { target });
    }
    if (need(PermissionFlagsBits.ManageRoles, 'Manage Roles')) return need(PermissionFlagsBits.ManageRoles, 'Manage Roles');
    const r = findRole(guild, role);
    if (!r) return `Error: there's no role called "${role}". Roles: ${guild.roles.cache.filter((x) => x.name !== '@everyone').map((x) => x.name).join(', ')}.`;
    if (r.position >= me.roles.highest.position) return `Error: the ${r.name} role is above mine, so I can't hand it out or take it away.`;
    if (action === 'add_role') await member.roles.add(r, why);
    else await member.roles.remove(r, why);
    return done(`${action === 'add_role' ? 'Gave' : 'Took'} ${r.name} ${action === 'add_role' ? 'to' : 'from'} ${target}.`, { target, role: r.name });
  }

  if (action === 'unban') {
    if (need(PermissionFlagsBits.BanMembers, 'Ban Members')) return need(PermissionFlagsBits.BanMembers, 'Ban Members');
    const bans = await guild.bans.fetch();
    const want = String(user ?? '').toLowerCase().replace(/^<@!?(\d+)>$/, '$1');
    const ban = bans.find((b) => b.user.id === want || b.user.username.toLowerCase() === want || b.user.globalName?.toLowerCase() === want);
    if (!ban) return `Error: nobody called "${user}" is banned. Banned: ${bans.map((b) => b.user.username).join(', ') || 'nobody'}.`;
    await guild.bans.remove(ban.user.id, why);
    return done(`Unbanned ${ban.user.username}.`, { target: ban.user.username });
  }

  const ch = findChannel(guild, channel, here);
  if (!ch || !ch.isTextBased?.()) return `Error: couldn't find a text channel called "${channel || '(this one)'}".`;

  if (action === 'slowmode') {
    if (need(PermissionFlagsBits.ManageChannels, 'Manage Channels')) return need(PermissionFlagsBits.ManageChannels, 'Manage Channels');
    const secs = Math.min(Math.max(Math.round((Number(minutes) || 0) * 60), 0), 21600);
    await ch.setRateLimitPerUser(secs, why);
    return done(secs ? `Slowmode in #${ch.name} is now ${secs >= 60 ? `${secs / 60} min` : `${secs}s`} between messages.` : `Slowmode is off in #${ch.name}.`, { channel: ch.name, seconds: secs });
  }

  if (action === 'delete_message' || action === 'clear') {
    if (need(PermissionFlagsBits.ManageMessages, 'Manage Messages')) return need(PermissionFlagsBits.ManageMessages, 'Manage Messages');
    if (action === 'delete_message' && message_id) {
      const msg = await ch.messages.fetch(String(message_id)).catch(() => null);
      if (!msg) return `Error: no message ${message_id} in #${ch.name}.`;
      await msg.delete();
      return done(`Deleted that message from ${msg.author.username} in #${ch.name}.`, { channel: ch.name, target: msg.author.username });
    }
    // Clear the last N messages, optionally only one person's. Discord bulk-deletes up to 100 at a
    // time and only messages under 14 days old.
    const n = Math.min(Math.max(Number(count) || (action === 'delete_message' ? 1 : 10), 1), 100);
    const member = user ? await findMember(guild, user) : null;
    if (user && !member) return `Error: couldn't find "${user}".`;
    const recent = await ch.messages.fetch({ limit: 100 });
    const ctxMessageId = ctx.messageId;
    const pick = [...recent.values()].filter((m) => m.id !== ctxMessageId && (!member || m.author.id === member.id) && Date.now() - m.createdTimestamp < 14 * 864e5).slice(0, n);
    if (!pick.length) return `Nothing to delete in #${ch.name}${member ? ` from ${member.displayName}` : ''}.`;
    const deleted = await ch.bulkDelete(pick, true);
    return done(`Deleted ${deleted.size} message${deleted.size === 1 ? '' : 's'}${member ? ` from ${member.displayName}` : ''} in #${ch.name}.`, { channel: ch.name, target: member?.displayName, count: deleted.size });
  }

  return `Error: unknown action "${action}".`;
}

// Basic spam guard: someone sending SPAM_COUNT messages within SPAM_WINDOW, or the same message
// three times in a row, is stopped. The first offence is her one warning plus a 5-minute timeout;
// the next offence while that warning is active is a kick. The owner is never touched.
const SPAM_COUNT = 6;
const SPAM_WINDOW = 8000;
const seen = new Map(); // userId -> [{ t, text }]
export async function spamGuard(message, isOwner) {
  if (!message.guild || message.author.bot || isOwner(message.author.id)) return;
  const list = (seen.get(message.author.id) ?? []).filter((x) => Date.now() - x.t < 60000);
  list.push({ t: Date.now(), text: message.content.trim().toLowerCase() });
  seen.set(message.author.id, list.slice(-10));
  const burst = list.filter((x) => Date.now() - x.t < SPAM_WINDOW).length >= SPAM_COUNT;
  const last3 = list.slice(-3);
  const repeat = last3.length === 3 && last3[0].text && last3.every((x) => x.text === last3[0].text);
  if (!burst && !repeat) return;
  seen.delete(message.author.id);
  const member = message.member;
  const me = message.guild.members.me;
  if (!member?.moderatable) return;
  const reason = burst ? `spam: ${SPAM_COUNT}+ messages in ${SPAM_WINDOW / 1000}s` : 'spam: same message 3 times';

  // Second offence after a warning: she said she'd kick, so she kicks.
  if (warningsFor(message.guild.id, member.id) && member.kickable && me.permissions.has(PermissionFlagsBits.KickMembers)) {
    await member.kick(reason).catch(() => {});
    clearWarning(message.guild.id, member.id);
    logAction({ action: 'kick', by: 'spam guard', guild: message.guild.name, target: member.displayName, reason: `${reason} (after a warning)`, channel: message.channel.name });
    message.channel.send({ content: `${member.displayName} was kicked for spamming again after a warning.`, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }

  // First offence: one warning, then the timeout that actually stops the spam.
  if (!warningsFor(message.guild.id, member.id)) {
    const delivery = await deliverWarning(message.guild, member, reason, 'spam guard', message.channel);
    logAction({ action: 'warn', by: 'spam guard', guild: message.guild.name, target: member.displayName, reason, delivery: delivery.where, channel: message.channel.name });
  }
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
  await member.timeout(5 * 60000, reason).catch(() => {});
  logAction({ action: 'timeout', by: 'spam guard', guild: message.guild.name, target: member.displayName, minutes: 5, reason, channel: message.channel.name });
  message.channel.send({ content: `${member.displayName} is in a 5-minute timeout for spamming.`, allowedMentions: { parse: [] } }).catch(() => {});
}
