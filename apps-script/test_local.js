// Local test of Code.gs with Apps Script globals mocked. Run: node test_local.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const mail = [], rows = [], cache = {};
const ctx = {
  console,
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  MailApp: { sendEmail: m => mail.push(m) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({ getLastRow: () => 1, appendRow: r => rows.push(r), setFrozenRows() {} }), insertSheet() {} }) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), ctx);
const post = p => JSON.parse(vm.runInContext('doPost', ctx)({ parameter: p }).s);
let r;
r = post({ kind: 'estimate', name: 'Ada Lovelace', email: 'ada@example.com', item: 'soc', qty: '10' });
assert.deepStrictEqual(r, { ok: true });
assert.strictEqual(rows[0][10], 600);                                   // 10 versions = $600
assert.strictEqual(mail.length, 2);                                     // owner + visitor
assert.ok(mail[1].subject.includes('$600') && mail[1].to === 'ada@example.com');
r = post({ kind: 'estimate', name: 'B', email: 'b@example.com', item: 'lt', qty: '30', rush: '1' });
assert.strictEqual(rows[1][10], Math.round(30 * 48 * 1.5));             // 25+ people tier, rush
r = post({ kind: 'estimate', name: 'C', email: 'c@example.com', item: 'cap', qty: '10' });
assert.strictEqual(rows[2][10], 250);                                   // minimum job
r = post({ kind: 'estimate', name: 'D', email: 'd@example.com', item: 'nope' });
assert.strictEqual(r.ok, false);
r = post({ kind: 'estimate', name: 'E', email: 'bad', item: 'cut' });
assert.strictEqual(r.ok, false);
const before = rows.length;
r = post({ kind: 'brief', name: 'F', email: 'f@example.com', hp: 'spam' });   // honeypot
assert.deepStrictEqual(r, { ok: true }); assert.strictEqual(rows.length, before);
const m0 = mail.length;
r = post({ kind: 'partner', name: 'G', email: 'g@example.com', company: 'Acme', volume: '10-30 / month' });
assert.deepStrictEqual(r, { ok: true });
assert.strictEqual(mail.length, m0 + 1);                                // partner: owner notification only
assert.strictEqual(rows[rows.length - 1][1], 'partner');
for (let i = 0; i < 8; i++) r = post({ kind: 'brief', name: 'H', email: 'h@example.com' });
assert.strictEqual(r.ok, false);                                        // rate limited after 6
r = post({ kind: 'brief', name: '<b>x</b>', email: 'i@example.com', brief: 'hi' });
assert.ok(rows[rows.length - 1][2].includes('<b>'));                    // stored as text (sheet), escaped only in HTML mail
console.log('all Apps Script checks passed;', rows.length, 'rows,', mail.length, 'emails');
