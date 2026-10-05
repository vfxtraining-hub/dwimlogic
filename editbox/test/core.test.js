'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../static/core.js');

const client = { email: 'client@example.com', role: 'client', name: 'Client' };
const other = { email: 'other@example.com', role: 'client' };
const editor = { email: 'editor@example.com', role: 'editor', name: 'Editor' };
const T0 = Date.parse('2026-10-01T12:00:00Z');
const D = C.DAY;

function setup() {
  const db = C.emptyDb();
  const p = C.createProject(db, client, { title: 'Launch film', deliverable: 'corporate', finishedMinutes: 2, footageMinutes: 90, description: 'Cut a 2 minute recap.' }, T0);
  return { db, p };
}

test('estimate is a range with a minimum pack to start', () => {
  const e = C.estimate({ deliverable: 'social', finishedMinutes: 1, versions: 10, footageMinutes: 30 });
  assert.ok(e.low >= 1 && e.high > e.low);
  assert.ok(C.PRICING.packs.some((p) => p.hours === e.minHours));
  assert.ok(e.minHours >= C.PRICING.minStartHours);
});

test('projects are private per client', () => {
  const { db, p } = setup();
  assert.strictEqual(C.listProjects(db, other).length, 0);
  assert.throws(() => C.find(db, other, p.id), /not found/);
  assert.strictEqual(C.listProjects(db, editor).length, 1);
  assert.throws(() => C.sendEstimate(db, client, p.id, { low: 4, high: 6 }, T0), /Only the editor/);
});

test('full lifecycle: estimate, prepay, chat, review, burn to zero, archive', () => {
  const { db, p } = setup();
  assert.throws(() => C.creditHours(db, p.id, { packId: 'p5' }, T0), /estimate/);
  C.sendEstimate(db, editor, p.id, { low: 8, high: 12, minHours: 10 }, T0);
  assert.strictEqual(p.status, 'estimated');
  assert.throws(() => C.creditHours(db, p.id, { packId: 'p5' }, T0), /at least/);
  C.creditHours(db, p.id, { packId: 'p10', ref: 'cs_1' }, T0);
  C.creditHours(db, p.id, { packId: 'p10', ref: 'cs_1' }, T0);
  assert.strictEqual(C.balance(p), 10, 'duplicate webhook is ignored');
  assert.strictEqual(p.status, 'active');

  C.postMessage(db, client, p.id, 'Hi, logo is in the drive.', T0);
  const v = C.postVersion(db, editor, p.id, { label: 'Rough cut', durationSec: 45 }, T0);
  C.addComment(db, client, p.id, v.id, { t: 12.5, body: 'Trim this shot' }, T0);
  C.setVersionStatus(db, client, p.id, v.id, 'changes_requested', T0);
  assert.throws(() => C.setVersionStatus(db, editor, p.id, v.id, 'approved', T0), /Only the client/);

  assert.throws(() => C.burnHours(db, editor, p.id, { hours: 11 }, T0), /Only 10 hrs left/);
  C.burnHours(db, editor, p.id, { hours: 9.75, note: 'Edit' }, T0);
  C.burnHours(db, editor, p.id, { hours: 0.25, note: 'Export' }, T0 + D);
  assert.strictEqual(p.status, 'depleted');
  assert.ok(p.purgeAfter);
  assert.ok(p.messages.some((m) => m.kind === 'depleted' && /archive subscription/.test(m.body)));

  C.activateArchive(db, p.id, { source: 'mock' }, T0 + 2 * D);
  assert.strictEqual(p.status, 'archived');
  assert.strictEqual(p.purgeAfter, null);
});

test('retention: source purged after 30 unused days, other files kept under archive', () => {
  const { db, p } = setup();
  C.addAsset(db, client, p.id, { kind: 'source', name: 'A001.mov', size: 100, key: 'k/src' }, T0);
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  C.addAsset(db, editor, p.id, { kind: 'deliverable', name: 'final.mp4', key: 'k/final' }, T0);
  C.burnHours(db, editor, p.id, { hours: 5 }, T0);
  C.activateArchive(db, p.id, { source: 'mock' }, T0);

  let r = C.runRetention(db, T0 + 25 * D);
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.sourcePurged.length, 0);
  r = C.runRetention(db, T0 + 31 * D, { dryRun: true });
  assert.deepStrictEqual(r.deleteKeys, ['k/src']);
  assert.ok(!p.assets[0].purgedAt, 'dry run does not mutate');
  r = C.runRetention(db, T0 + 31 * D);
  assert.deepStrictEqual(r.deleteKeys, ['k/src']);
  assert.strictEqual(p.status, 'archived');
  assert.ok(!p.assets[1].purgedAt, 'deliverable kept while archived');
  r = C.runRetention(db, T0 + 400 * D);
  assert.strictEqual(r.projectsPurged.length, 0, 'archive keeps project indefinitely');
});

test('retention: burning hours counts as using the source', () => {
  const { db, p } = setup();
  C.addAsset(db, client, p.id, { kind: 'source', name: 'B.mov', key: 'k/b' }, T0);
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.creditHours(db, p.id, { packId: 'p20' }, T0);
  C.burnHours(db, editor, p.id, { hours: 1 }, T0 + 20 * D);
  assert.strictEqual(C.runRetention(db, T0 + 31 * D).sourcePurged.length, 0);
  assert.strictEqual(C.runRetention(db, T0 + 51 * D).sourcePurged.length, 1);
});

test('retention: declined archive purges files after download window, keeps the log', () => {
  const { db, p } = setup();
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  C.addAsset(db, editor, p.id, { kind: 'render', name: 'v1.mp4', key: 'k/v1' }, T0);
  C.burnHours(db, editor, p.id, { hours: 5 }, T0);
  C.declineArchive(db, client, p.id, T0);
  assert.strictEqual(C.runRetention(db, T0 + 6 * D).projectsPurged.length, 0);
  const r = C.runRetention(db, T0 + 8 * D);
  assert.deepStrictEqual(r.projectsPurged, [p.id]);
  assert.deepStrictEqual(r.deleteKeys, ['k/v1']);
  assert.strictEqual(p.status, 'purged');
  assert.ok(p.messages.length > 3 && p.ledger.length === 2);
  assert.throws(() => C.addAsset(db, client, p.id, { name: 'x' }, T0), /Start a new project/);
});

test('retention: canceled archive ends at period end, then grace, then purge', () => {
  const { db, p } = setup();
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  C.burnHours(db, editor, p.id, { hours: 5 }, T0);
  C.activateArchive(db, p.id, { source: 'stripe', subscriptionId: 'sub_1', currentPeriodEnd: T0 + 30 * D }, T0);
  C.cancelArchive(db, client, p.id, T0 + D);
  assert.strictEqual(C.runRetention(db, T0 + 29 * D).archivesEnded.length, 0);
  C.runRetention(db, T0 + 30 * D);
  assert.strictEqual(p.status, 'depleted');
  assert.strictEqual(C.runRetention(db, T0 + 38 * D).projectsPurged.length, 1);
});

test('top up after depletion reactivates and clears purge date', () => {
  const { db, p } = setup();
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  C.burnHours(db, editor, p.id, { hours: 5 }, T0);
  C.declineArchive(db, client, p.id, T0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0 + D);
  assert.strictEqual(p.status, 'active');
  assert.strictEqual(p.purgeAfter, null);
  assert.strictEqual(C.runRetention(db, T0 + 20 * D).projectsPurged.length, 0);
});

test('clients cannot upload editor-only file kinds; public view hides storage keys', () => {
  const { db, p } = setup();
  assert.throws(() => C.addAsset(db, client, p.id, { kind: 'deliverable', name: 'x' }, T0), /Clients can add/);
  C.addAsset(db, client, p.id, { url: 'https://we.tl/t-abc' }, T0);
  C.addAsset(db, client, p.id, { name: 'a.mov', key: 'secret/key' }, T0);
  const pub = C.publicProject(p);
  assert.ok(pub.assets.every((a) => !('key' in a)));
  assert.strictEqual(pub.assets[1].hasFile, true);
  assert.throws(() => C.addAsset(db, client, p.id, { url: 'javascript:alert(1)' }, T0), /http/);
});

test('agent workflow: hand off, packet, claim, version, revision loop, hours pause', () => {
  const { db, p } = setup();
  const agent = { email: 'agent:grok-bot', role: 'agent', name: 'grok-bot' };
  const otherAgent = { email: 'agent:other', role: 'agent', name: 'other' };
  C.addAsset(db, client, p.id, { kind: 'source', name: 'A.mov', key: 'k/a' }, T0);
  assert.strictEqual(C.listProjects(db, agent).length, 0, 'agents only see jobs handed to them');
  C.sendEstimate(db, editor, p.id, { low: 4, high: 5 }, T0);
  C.assignWork(db, editor, p.id, { agent: 'grok-bot', instructions: 'Keep it punchy.' }, T0);
  assert.strictEqual(p.work.state, 'paused_no_hours');
  assert.strictEqual(C.agentInbox(db, agent).length, 0);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  assert.strictEqual(p.work.state, 'queued_for_agent');
  assert.strictEqual(C.agentInbox(db, agent).length, 1);
  assert.strictEqual(C.listProjects(db, otherAgent).length, 0);
  assert.throws(() => C.sendEstimate(db, agent, p.id, { low: 1, high: 2 }, T0), /Only the editor/);
  assert.throws(() => C.updateWork(db, agent, p.id, { state: 'done' }, T0), /Agents can set/);

  const k = C.jobPacket(p, (a) => 'https://files/' + a.id);
  assert.strictEqual(k.schema, 'editbox.job/1');
  assert.strictEqual(k.work.task, 'first_cut');
  assert.strictEqual(k.delivery.nle, 'DaVinci Resolve');
  assert.strictEqual(k.media[0].url, 'https://files/' + p.assets[0].id);
  assert.strictEqual(k.hours.balance, 5);
  assert.match(C.jobPacketMarkdown(k), /## Instructions from the editor\nKeep it punchy\./);

  C.claimWork(db, agent, p.id, T0);
  assert.strictEqual(p.work.state, 'in_edit');
  C.burnHours(db, agent, p.id, { hours: 2, note: 'Assembly in Resolve' }, T0);
  const v = C.postVersion(db, agent, p.id, { label: 'First cut' }, T0);
  assert.strictEqual(p.work.state, 'awaiting_client');
  C.addComment(db, client, p.id, v.id, { t: 4, body: 'Swap the music' }, T0);
  C.setVersionStatus(db, client, p.id, v.id, 'changes_requested', T0);
  assert.strictEqual(p.work.state, 'queued_for_agent');
  assert.strictEqual(p.work.task, 'revision');
  assert.deepStrictEqual(C.jobPacket(p).openNotes.map((n) => n.body), ['Swap the music']);
  C.updateWork(db, agent, p.id, { state: 'needs_editor', note: 'Music licence question' }, T0);
  assert.ok(p.messages.some((m) => /flagged this for the editor: Music licence/.test(m.body)));
  C.burnHours(db, agent, p.id, { hours: 3 }, T0);
  assert.strictEqual(p.work.state, 'paused_no_hours');
  assert.throws(() => C.burnHours(db, agent, p.id, { hours: 1 }, T0), /prepaid hours/);
  C.creditHours(db, p.id, { packId: 'p5' }, T0);
  assert.strictEqual(p.work.state, 'queued_for_agent');
});
