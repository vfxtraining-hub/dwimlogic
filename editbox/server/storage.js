'use strict';
/* Object storage. "local" writes to EDITBOX_DATA_DIR/files (development and small installs).
 * "s3" issues SigV4 presigned URLs so browsers upload and download directly; works with AWS S3,
 * Cloudflare R2, Backblaze B2 and other S3-compatible stores. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function presign(cfg, method, key, opts) {
  opts = opts || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amz.slice(0, 8);
  const region = cfg.region || 'us-east-1';
  let host, uriPath;
  const encKey = key.split('/').map(enc).join('/');
  if (cfg.endpoint) {
    const u = new URL(cfg.endpoint);
    host = cfg.forcePathStyle ? u.host : cfg.bucket + '.' + u.host;
    uriPath = cfg.forcePathStyle ? '/' + cfg.bucket + '/' + encKey : '/' + encKey;
  } else {
    host = cfg.forcePathStyle ? 's3.' + region + '.amazonaws.com' : cfg.bucket + '.s3.amazonaws.com';
    uriPath = cfg.forcePathStyle ? '/' + cfg.bucket + '/' + encKey : '/' + encKey;
  }
  const scope = date + '/' + region + '/s3/aws4_request';
  const q = Object.assign({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': cfg.accessKeyId + '/' + scope,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(opts.expires || 3600),
    'X-Amz-SignedHeaders': 'host'
  }, opts.query || {});
  const qs = Object.keys(q).sort().map((k) => enc(k) + '=' + enc(q[k])).join('&');
  const canonical = [method, uriPath, qs, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const kDate = hmac('AWS4' + cfg.secretAccessKey, date);
  const kSig = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(toSign).digest('hex');
  const proto = cfg.endpoint ? new URL(cfg.endpoint).protocol : 'https:';
  return proto + '//' + host + uriPath + '?' + qs + '&X-Amz-Signature=' + sig;
}

function create(cfg, dataDir, baseUrl) {
  const filesDir = path.join(dataDir, 'files');
  if (cfg.driver === 's3') {
    if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('S3 storage needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    return {
      driver: 's3',
      uploadTarget: (key) => ({ method: 'PUT', url: presign(cfg, 'PUT', key, { expires: 6 * 3600 }), headers: {} }),
      downloadUrl: (key, name) => presign(cfg, 'GET', key, { expires: 3600, query: { 'response-content-disposition': 'inline; filename="' + String(name).replace(/["\\\r\n]/g, '') + '"' } }),
      remove: async (key) => {
        const r = await fetch(presign(cfg, 'DELETE', key, { expires: 300 }), { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error('S3 delete failed: ' + r.status);
      }
    };
  }
  fs.mkdirSync(filesDir, { recursive: true });
  const safe = (key) => {
    const p = path.resolve(filesDir, key);
    if (!p.startsWith(filesDir + path.sep)) throw new Error('bad key');
    return p;
  };
  return {
    driver: 'local',
    filePath: safe,
    uploadTarget: (key, token) => ({ method: 'PUT', url: '/editbox/api/upload/' + token, headers: {} }),
    downloadUrl: null,
    remove: async (key) => { fs.rmSync(safe(key), { force: true }); }
  };
}

module.exports = { create, presign };
