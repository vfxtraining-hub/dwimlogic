'use strict';
/* Retention job for cron or a scheduled task:  node server/retention.js [--dry-run]
 * Rules live in static/core.js (runRetention). The server also runs this every
 * EDITBOX_RETENTION_INTERVAL_HOURS, so cron is only needed when the server is not long-lived. */
const path = require('path');
const env = require('./env.js');
const { createApp } = require('./server.js');

env.loadDotEnv(path.join(env.EDITBOX, '.env'));
const app = createApp(env.config());
const dryRun = process.argv.includes('--dry-run');
app.retention(dryRun).then((report) => {
  console.log(JSON.stringify(report, null, 2));
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
