'use strict';
/* Transactional email through Resend's HTTP API when RESEND_API_KEY is set; otherwise logged to the console. */

function create(cfg) {
  async function send(to, subject, text) {
    if (!to) return { skipped: true };
    if (!cfg.resendKey) {
      console.log('[editbox mail] to=%s subject=%s\n%s\n', to, subject, text);
      return { logged: true };
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, text })
    });
    if (!r.ok) console.error('[editbox mail] send failed', r.status, await r.text());
    return { sent: r.ok };
  }
  return { send, configured: !!cfg.resendKey };
}

module.exports = { create };
