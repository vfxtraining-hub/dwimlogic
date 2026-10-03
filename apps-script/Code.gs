/**
 * DWIM Logic lead capture. Google Apps Script web app.
 *
 * Receives form posts from the website, logs each lead to a Google Sheet, emails you,
 * and (for estimates) emails the visitor a branded copy of their estimate.
 *
 * Kinds handled: "estimate", "partner", "brief".
 * Setup: see SETUP.md.
 */

// ---- CONFIG: edit these ----
var OWNER_EMAIL = 'hello@dwimlogic.com';   // where lead notifications go, and the reply-to address
var BRAND = 'DWIM Logic';
var SHEET_NAME = 'Leads';
var MAX_PER_HOUR = 6;                      // per email address, to blunt spam

// Draft rate card. Keep in sync with the estimator on the site (site.src.html, var E).
var RATES = {
  cut:  { name: 'Overflow cutdowns',            unit: 150,  min: 1,   per: 'deliverable', tat: '24–72 hrs' },
  soc:  { name: 'Social versions',              unit: 60,   min: 10,  per: 'version',     tat: 'about 3 days' },
  lt:   { name: 'Lower thirds (people)',        unit: 50,   min: 10,  per: 'person',      tat: '48 hrs' },
  spot: { name: '60-second brand spots',        unit: 2500, min: 1,   per: 'spot',        tat: '1–2 weeks' },
  cap:  { name: 'Captions with human QC (minutes)', unit: 2.5, min: 100, per: 'minute',  tat: '24–48 hrs' }
};
var RUSH = 1.5;

// ---- Entry point ----
function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.hp) return json_({ ok: true });                 // honeypot filled: pretend success
    var kind = String(p.kind || 'brief');
    if (['estimate', 'partner', 'brief'].indexOf(kind) < 0) return json_({ ok: false, error: 'bad kind' });

    var name = clean_(p.name, 120), email = clean_(p.email, 160);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return json_({ ok: false, error: 'name and email required' });
    if (!allow_(email)) return json_({ ok: false, error: 'too many requests' });

    var lead = { kind: kind, name: name, email: email, company: clean_(p.company, 160), volume: clean_(p.volume, 80),
                 type: clean_(p.type, 80), brief: clean_(p.brief, 4000), quote: null };

    if (kind === 'estimate') {
      lead.quote = quote_(String(p.item || ''), p.qty, p.rush === '1' || p.rush === 'true');
      if (!lead.quote) return json_({ ok: false, error: 'bad item' });
    }

    log_(lead);
    notifyOwner_(lead);
    if (kind === 'estimate') emailEstimate_(lead);
    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server error' });
  }
}

function doGet() { return json_({ ok: true, service: BRAND + ' lead capture' }); }

// ---- Pricing (server side, so emails cannot be tampered with) ----
function quote_(item, qtyRaw, rush) {
  var r = RATES[item]; if (!r) return null;
  var qty = Math.max(1, Math.floor(Number(qtyRaw) || 1)), note = '';
  if (qty < r.min) { qty = r.min; note = 'Minimum is ' + r.min + '.'; }
  var unit = r.unit; if (item === 'lt' && qty >= 25) unit = 48;
  var total = qty * unit;
  if (item === 'cap' && total < 250) { total = 250; note = 'Minimum job is $250.'; }
  var mult = rush ? RUSH : 1;
  return { item: item, name: r.name, qty: qty, unit: unit * mult, per: r.per, total: Math.round(total * mult),
           tat: rush ? 'under 24 hrs (rush)' : r.tat, rush: !!rush, note: note };
}

// ---- Helpers ----
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 200); }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function money_(n) { return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function allow_(email) {
  var cache = CacheService.getScriptCache(), key = 'rl:' + email.toLowerCase();
  var n = Number(cache.get(key) || 0);
  if (n >= MAX_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3600);
  return true;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Received', 'Kind', 'Name', 'Email', 'Company', 'Volume', 'Need', 'Item', 'Qty', 'Rush', 'Estimate USD', 'Brief', 'Status']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function log_(l) {
  var q = l.quote;
  sheet_().appendRow([new Date(), l.kind, l.name, l.email, l.company, l.volume, l.type,
    q ? q.name : '', q ? q.qty : '', q ? (q.rush ? 'yes' : 'no') : '', q ? q.total : '', l.brief, 'new']);
}

function notifyOwner_(l) {
  var q = l.quote, lines = [
    'New ' + l.kind + ' lead', '',
    'Name: ' + l.name, 'Email: ' + l.email,
    l.company ? 'Company: ' + l.company : '', l.volume ? 'Monthly volume: ' + l.volume : '',
    l.type ? 'Need: ' + l.type : '',
    q ? 'Estimate: ' + q.qty + ' x ' + q.name + (q.rush ? ' (rush)' : '') + ' = ' + money_(q.total) : '',
    l.brief ? '\nBrief:\n' + l.brief : ''
  ].filter(function (x) { return x !== ''; });
  MailApp.sendEmail({ to: OWNER_EMAIL, replyTo: l.email, name: BRAND + ' site',
    subject: 'New ' + l.kind + ' lead: ' + l.name + (q ? ' (' + money_(q.total) + ')' : ''), body: lines.join('\n') });
}

function emailEstimate_(l) {
  var q = l.quote, first = l.name.split(' ')[0];
  var text = 'Hi ' + first + ',\n\nHere is your estimate.\n\n' +
    q.qty + ' x ' + q.name + (q.rush ? ' (rush)' : '') + '\n' +
    money_(q.unit) + ' per ' + q.per + '  ·  ' + q.tat + '\n' +
    'Estimate: ' + money_(q.total) + '\n' + (q.note ? q.note + '\n' : '') +
    '\nThis is a draft estimate, not a quote. Send a brief and you get a fixed price and date within 48 hours. ' +
    'Two revision rounds are included. New agency partners get a first cutdown free.\n\nReply to this email with your brief, or just reply with questions.\n\n' + BRAND;
  var html = '<div style="font:16px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#10151c;max-width:560px">' +
    '<p style="font:800 22px Impact,Arial Narrow,sans-serif;letter-spacing:.02em;margin:0 0 18px">DWIM<span style="color:#e0301f">LOGIC</span></p>' +
    '<p>Hi ' + esc_(first) + ',</p><p>Here is your estimate.</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:18px 0"><tr><td style="padding:14px 0;border-top:2px solid #10151c"><b>' + q.qty + ' × ' + esc_(q.name) + (q.rush ? ' (rush)' : '') + '</b><br>' +
    '<span style="color:#566170">' + money_(q.unit) + ' per ' + esc_(q.per) + ' · ' + esc_(q.tat) + '</span></td>' +
    '<td style="padding:14px 0;border-top:2px solid #10151c;text-align:right;font:800 30px Impact,Arial Narrow,sans-serif;color:#e0301f">' + money_(q.total) + '</td></tr></table>' +
    (q.note ? '<p style="color:#566170">' + esc_(q.note) + '</p>' : '') +
    '<p style="color:#566170">This is a draft estimate, not a quote. Send a brief and you get a fixed price and date within 48 hours. Two revision rounds are included. New agency partners get a first cutdown free.</p>' +
    '<p>Reply to this email with your brief, or just reply with questions.</p><p>' + esc_(BRAND) + '</p></div>';
  MailApp.sendEmail({ to: l.email, replyTo: OWNER_EMAIL, name: BRAND,
    subject: 'Your ' + BRAND + ' estimate: ' + money_(q.total), body: text, htmlBody: html });
}
