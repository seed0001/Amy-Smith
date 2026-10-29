import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { runTool, enabledTools } from './tools.js';

// A fake server with one text channel and two members.
function fakeDiscord({ canSend = true } = {}) {
  const sent = [];
  const members = new Collection([
    ['111111111111111111', { id: '111111111111111111', displayName: 'Chris', user: { username: 'chrisx', globalName: 'Chris' } }],
    ['222222222222222222', { id: '222222222222222222', displayName: 'Luna', user: { username: 'luna', globalName: null } }],
  ]);
  const guild = {
    name: 'Test',
    members: {
      me: { id: 'bot' },
      fetch: async (id) => (id ? members.get(id) ?? Promise.reject(new Error('unknown')) : members),
      cache: members,
    },
  };
  const channel = {
    id: '999999999999999999', name: 'general', type: ChannelType.GuildText, guild,
    permissionsFor: () => ({ has: () => canSend }),
    send: async (msg) => { sent.push(msg); return { url: 'https://discord.com/channels/1/2/3', edit: async (e) => sent.push(e) }; },
  };
  guild.channels = { cache: new Collection([[channel.id, channel]]) };
  const client = { guilds: { cache: new Collection([['g', guild]]) }, channels: { cache: new Collection([[channel.id, channel]]), fetch: async () => null } };
  // No real recorder in tests: no clip unless a test supplies one.
  return { sent, ctx: { client, guild, perms: { owner: true }, requestClip: async () => null } };
}

test('post_message adds the avatar clip to the post when one arrives', async () => {
  const { ctx, sent } = fakeDiscord();
  const clip = Buffer.from('webm');
  let spoken;
  const result = await runTool('post_message', { channel: '#general', text: 'video test' }, { ...ctx, requestClip: async (t) => ((spoken = t), clip) });
  assert.match(result, /Posted in #general/);
  await new Promise((r) => setImmediate(r));
  assert.equal(spoken, 'video test');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].files[0].attachment, clip);
});

test('post_message is owner only', async () => {
  const { ctx } = fakeDiscord();
  assert.ok(enabledTools(ctx).some((t) => t.function.name === 'post_message'));
  assert.ok(!enabledTools({ ...ctx, perms: { friend: true } }).some((t) => t.function.name === 'post_message'));
  const result = await runTool('post_message', { channel: '#general', text: 'hi' }, { ...ctx, perms: {} });
  assert.match(result, /isn't available/);
});

test('post_message posts with real pings only for the members asked for', async () => {
  const { ctx, sent } = fakeDiscord();
  const result = await runTool('post_message', { channel: 'general', text: 'hey @Chris, game night @everyone', mention: ['chris', 'Luna'] }, ctx);
  assert.match(result, /Posted in #general/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '<@222222222222222222> hey <@111111111111111111>, game night @everyone');
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['111111111111111111', '222222222222222222'] });
  const again = await runTool('post_message', { channel: 'general', text: 'hey @Chris, game night @everyone', mention: ['chris', 'Luna'] }, ctx);
  assert.match(again, /already posted/);
  assert.equal(sent.length, 1);
});

test('post_message refuses unknown channels, unknown members and missing permission', async () => {
  const { ctx, sent } = fakeDiscord();
  assert.match(await runTool('post_message', { channel: '#nope', text: 'hi' }, ctx), /no text channel/);
  assert.match(await runTool('post_message', { channel: '#general', text: 'hi', mention: ['Zed'] }, ctx), /couldn't find "Zed"/);
  const locked = fakeDiscord({ canSend: false });
  assert.match(await runTool('post_message', { channel: '#general', text: 'hi' }, locked.ctx), /permission/);
  assert.equal(sent.length + locked.sent.length, 0);
});
