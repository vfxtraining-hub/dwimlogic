'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EDITBOX = path.resolve(__dirname, '..');

// Minimal .env loader (KEY=value, # comments). Real environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function config(env) {
  env = env || process.env;
  const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 8787);
  return {
    root: ROOT,
    editboxDir: EDITBOX,
    port,
    production,
    baseUrl: (env.EDITBOX_BASE_URL || 'http://localhost:' + port).replace(/\/$/, ''),
    dataDir: path.resolve(env.EDITBOX_DATA_DIR || path.join(EDITBOX, 'data')),
    adminEmails: list(env.EDITBOX_ADMIN_EMAILS),
    // EDITBOX_AGENT_KEYS=grok-bot:long-random-secret,cursor-agent:another-secret
    agents: String(env.EDITBOX_AGENT_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
      const i = pair.indexOf(':');
      return { name: pair.slice(0, i).trim(), key: pair.slice(i + 1).trim() };
    }).filter((a) => /^[\w.-]{2,60}$/.test(a.name) && a.key.length >= 16),
    sessionSecret: env.EDITBOX_SESSION_SECRET || '',
    // Shows the magic link on screen instead of emailing it. Never enable in production.
    devLogin: !production && (env.EDITBOX_DEV_LOGIN === '1' || !env.RESEND_API_KEY),
    mail: { resendKey: env.RESEND_API_KEY || '', from: env.EDITBOX_MAIL_FROM || 'The Edit Box <editbox@dwimlogic.com>' },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      archivePriceId: env.STRIPE_ARCHIVE_PRICE_ID || ''
    },
    storage: {
      driver: env.EDITBOX_STORAGE || (env.S3_BUCKET ? 's3' : 'local'),
      bucket: env.S3_BUCKET || '',
      region: env.S3_REGION || 'auto',
      endpoint: (env.S3_ENDPOINT || '').replace(/\/$/, ''),
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === '1' || !!env.S3_ENDPOINT,
      maxUploadMb: Number(env.EDITBOX_MAX_UPLOAD_MB || 51200)
    },
    retentionEveryHours: Number(env.EDITBOX_RETENTION_INTERVAL_HOURS || 6)
  };
}

module.exports = { loadDotEnv, config, ROOT, EDITBOX };
