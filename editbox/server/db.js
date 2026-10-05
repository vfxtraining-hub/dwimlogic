'use strict';
/* JSON file store. Fine for a one-editor studio at MVP volume; swap for Postgres by keeping the same shape
 * (projects as documents, or split ledger/messages/assets/versions into tables keyed by project_id). */
const fs = require('fs');
const path = require('path');
const core = require('../static/core.js');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let db;
  if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  else db = core.emptyDb();
  db.sessions = db.sessions || [];
  db.tokens = db.tokens || [];
  db.checkouts = db.checkouts || [];
  db.uploads = db.uploads || [];
  db.events = db.events || [];

  let queue = Promise.resolve();
  function save() {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  }
  /* Serialises every mutation so concurrent requests never interleave a read-modify-write. */
  function tx(fn) {
    const run = queue.then(async () => {
      const out = await fn(db);
      save();
      return out;
    });
    queue = run.catch(() => {});
    return run;
  }
  return { db, tx, save, file };
}

module.exports = { open };
