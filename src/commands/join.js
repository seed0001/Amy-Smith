import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { joinChannel } from '../voice/session.js';
import { config } from '../config.js';
import { ttsReady } from '../voice/provider.js';
import { xttsAvailability } from '../voice/xtts.js';

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your voice channel and start listening')
  .setDMPermission(false);

export async function execute(interaction) {
  const channel = interaction.member.voice?.channel;
  if (!channel) {
    return interaction.reply({ content: 'Join a voice channel first, then run /join.', flags: MessageFlags.Ephemeral });
  }
  const allowed = config.voice.channelIds;
  if (allowed.length && !allowed.includes(channel.id)) {
    const names = allowed.map((id) => `<#${id}>`).join(', ');
    return interaction.reply({ content: `I'm only allowed in: ${names}`, flags: MessageFlags.Ephemeral });
  }
  if (!ttsReady(config)) {
    return interaction.reply({ content: config.tts === 'xtts' ? xttsAvailability().reason : 'Fish Audio needs its API key. You can also select a configured local speech provider.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply();
  try {
    await joinChannel(channel, interaction.channel);
    await interaction.editReply(`Hopped into **${channel.name}**. Just talk, I'm listening.`);
  } catch (err) {
    await interaction.editReply(`Couldn't join: ${err.message}`);
  }
}
