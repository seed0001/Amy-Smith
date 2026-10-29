import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenReceived, fileTitle, findReceived, noteReceived, sharedFileMemories } from './attachments.js';

const manual = { name: 'HeavyWaterFirewall-Manual.txt', saved: 'data/files/received/x_HeavyWaterFirewall-Manual.txt', text: 'secret contents' };
const date = new Date(2026, 9, 28);

test('file names become words recall can match', () => {
  assert.equal(fileTitle('HeavyWaterFirewall-Manual.txt'), 'Heavy Water Firewall Manual');
  assert.equal(fileTitle('easy_tacos.md'), 'easy tacos');
});

test('a document sent in a channel is remembered with her take and where it is saved', () => {
  const [fact] = sharedFileMemories({ speakerName: 'Travis', files: [manual], where: '#bot', take: 'I read it.\nIt covers ARP alerts.', date });
  assert.match(fact, /^Oct 28, 2026: Travis sent you "Heavy Water Firewall Manual" \(HeavyWaterFirewall-Manual\.txt\) in #bot, and you read it\./);
  assert.match(fact, /Your reply then: "I read it\. It covers ARP alerts\."/);
  assert.match(fact, /saved at data\/files\/received\/x_HeavyWaterFirewall-Manual\.txt/);
  assert.doesNotMatch(fact, /secret contents/); // the memory points at the file, it doesn't copy it
  assert.doesNotMatch(fact, /private/);
});

test('a document sent by DM stays marked private to the sender', () => {
  const [fact] = sharedFileMemories({ speakerName: 'Travis', files: [manual], where: '#bot', dm: true, date });
  assert.match(fact, /in a private DM/);
  assert.match(fact, /only discuss it with Travis, or when Travis brings it up/);
  assert.doesNotMatch(fact, /#bot/);
});

test('pictures are remembered as looked at', () => {
  const [fact] = sharedFileMemories({ speakerName: 'Hal', files: [{ name: 'me.png', saved: 'p', mime: 'image/png' }], where: '#general', date });
  assert.match(fact, /you looked at it\./);
});

test('the file memory points at a tool every tier has, and says to open it before quoting', () => {
  const [fact] = sharedFileMemories({ speakerName: 'ultrahal', files: [manual], where: '#bots', date });
  assert.match(fact, /received_file/);
  assert.doesNotMatch(fact, /files tool/); // files is owner-only: a guest's turn can't use it
  assert.match(fact, /open it before quoting or answering details/);
});

// Who may open a received file.
const guild = 'g1';
const hal = { speakerId: 'hal', guild };
test('a channel file opens for its sender, others in that server and the owner, not another server', () => {
  const f = { from: 'hal', dm: false, guild };
  assert.ok(canOpenReceived(f, hal));
  assert.ok(canOpenReceived(f, { speakerId: 'pritrix', guild }));
  assert.ok(canOpenReceived(f, { speakerId: 'travis', owner: true, guild: null }));
  assert.ok(!canOpenReceived(f, { speakerId: 'pritrix', guild: 'g2' }));
  assert.ok(!canOpenReceived(f, { speakerId: 'pritrix', guild: null })); // from someone's DM
});

test('a DM file opens only for its sender and the owner, even in the same server', () => {
  const f = { from: 'hal', dm: true, guild: null };
  assert.ok(canOpenReceived(f, hal));
  assert.ok(canOpenReceived(f, { speakerId: 'travis', owner: true, guild }));
  assert.ok(!canOpenReceived(f, { speakerId: 'pritrix', guild }));
});

test('a saved message from before dm was recorded only opens for its sender', () => {
  const row = { user_id: 'hal', name: 'ultrahal', created_at: 1, attachments: JSON.stringify({ docs: [{ name: 'Old-Notes.txt', saved: 'old', text: 'old text' }] }) };
  assert.equal(findReceived('old notes', hal, [row]).open.length, 1);
  const other = findReceived('old notes', { speakerId: 'pritrix', guild }, [row]);
  assert.equal(other.open.length, 0);
  assert.equal(other.hidden, 1);
});

test('a file sent in a channel is findable from voice the moment it arrives, before the reply is saved', () => {
  noteReceived({
    attachments: { docs: [{ name: 'HeavyWaterFirewall-Manual1.txt', saved: 'race_HeavyWaterFirewall-Manual1.txt', text: 'DNS probing: checks port 53.' }], images: [], notes: [] },
    from: 'hal', fromName: 'ultrahal', dm: false, guild, where: '#bots',
  });
  // Nothing in the database yet (rows = []): the voice turn still gets the text, for anyone in the server.
  const { open } = findReceived('the heavy water manual', { speakerId: 'pritrix', guild }, []);
  assert.equal(open[0]?.saved, 'race_HeavyWaterFirewall-Manual1.txt');
  assert.match(open[0].text, /DNS probing/);
});

test('a DM file noted on arrival stays hidden from others, and the saved copy is not counted twice', () => {
  const doc = { name: 'Private-Plans.txt', saved: 'dm_Private-Plans.txt', text: 'secret' };
  noteReceived({ attachments: { docs: [doc], images: [] }, from: 'hal', fromName: 'ultrahal', dm: true, guild: null, where: 'a DM' });
  const row = { user_id: 'hal', name: 'ultrahal', created_at: 2, attachments: JSON.stringify({ docs: [doc], dm: true, guild: null }) };
  const other = findReceived('private plans', { speakerId: 'pritrix', guild }, [row]);
  assert.equal(other.open.length, 0);
  assert.equal(other.hidden, 1);
  assert.equal(findReceived('private plans', hal, [row]).open.length, 1);
});
