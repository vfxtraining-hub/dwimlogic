# The Edit Box

A DWIM Logic service at **`/editbox`**. Clients send footage and a brief, get a free estimate, prepay a pack of editing hours, talk to the editor in a logged project thread, review every version in the browser with frame-pinned notes, and choose an archive subscription when the hours are used.

It is also the **inbox for the editing agent** (Grok Bot, Cursor agents). Yan hands a job to an agent, the agent pulls the brief, media and full message log, edits in DaVinci Resolve, posts versions back for client review and logs its hours against the prepaid balance.

| URL | What |
|---|---|
| `/editbox/` | Shareable landing page (LinkedIn-ready, Open Graph image at `editbox/static/og.png`) |
| `/editbox/portal/` | Client portal: request, estimate, buy hours, messages, versions, files, hours, archive |
| `/editbox/studio/` | Editor studio: all projects, estimates, work queue and agent hand-off, versions, hour logging, retention |
| `/editbox/api/…` | JSON API (live mode only), including the agent endpoints |

The main site links to it from the header nav ("Edit Box") and the footer.

## Two modes

**Demo mode** (any static host, including the current dwimlogic.com host). Everything runs in the browser: the same business rules, with data in `localStorage` and demo renders in IndexedDB. Nothing is charged and no files leave the browser. A demo bar lets you switch between the Client and Editor views, move the demo date forward (+1 day, +31 days, which also runs the retention job) and reset. This is what Yan can share today.

**Live mode** (`editbox/server`, Node 18+, zero npm dependencies). Magic-link sign-in, private projects per client, uploads to local disk or S3/R2, Stripe Checkout with webhooks, email notifications, scheduled retention and the agent API. When the server serves the pages, it answers `/editbox/static/config.js` with `{mode:'live'}`, so the same frontend switches over.

Both modes run the same `editbox/static/core.js`, so prices, state changes, permissions and retention behave the same way in both.

## Run it

```bash
# Demo only: any static file server from the repo root
python3 -m http.server 8080        # open http://localhost:8080/editbox/

# Live server (also serves the main site at /)
cd editbox
cp .env.example .env               # set EDITBOX_ADMIN_EMAILS at least
npm run dev                        # http://localhost:8787/editbox/  (sign-in links shown on screen)
npm test                           # core rules + API end to end (node:test, no installs)
npm run retention:dry              # preview what the retention job would remove
```

Without `RESEND_API_KEY`, outside production, the sign-in link is shown on screen and printed to the console. Without `STRIPE_SECRET_KEY`, checkout is a labelled test checkout that charges nothing and records `source: "mock"` in the ledger.

### One-minute demo walkthrough

1. Open `/editbox/`, then **Walk through the demo**. Sign in with **Use a sample client**.
2. **Start a project**. The preliminary estimate updates as you type. Submit.
3. Switch to **Editor** in the demo bar. Open the project and **Send estimate**. Optionally **Hand to agent** (grok-bot).
4. Switch to **Client**. Pick an hour pack and **Complete demo payment**.
5. Editor: **Simulate agent run** (the agent claims the job, posts in the thread, posts V1 and logs hours) or post a version and log hours yourself.
6. Client: open **Versions → V1**, play it, pause and **Add note** (pinned to the frame), then **Request changes**. The job goes back into the agent queue as a revision.
7. Editor: simulate again (V2), then log the remaining hours (**All left**). Hours are used up.
8. Client: the **archive offer** appears. Subscribe (demo), or **No thanks, remove the files**.
9. Click **+31 days**. The retention job clears source footage (and, if declined, the project files), with the reasons written into the thread.

## Environment variables

See `editbox/.env.example` for the full list.

| Variable | Purpose |
|---|---|
| `PORT`, `EDITBOX_BASE_URL` | Listen port and public URL (used in emails, Stripe return URLs and agent media URLs) |
| `EDITBOX_ADMIN_EMAILS` | Comma-separated editor accounts. Everyone else is a client. |
| `EDITBOX_DATA_DIR` | Location of `db.json` and local uploads. Back it up. |
| `RESEND_API_KEY`, `EDITBOX_MAIL_FROM` | Magic links and notifications through Resend. Unset means logged to the console. |
| `EDITBOX_DEV_LOGIN=1` | Show sign-in links on screen. Ignored when `NODE_ENV=production`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Checkout and webhook verification. Unset means mock checkout. |
| `STRIPE_ARCHIVE_PRICE_ID` | Optional recurring Price for the archive subscription |
| `EDITBOX_STORAGE` | `local` (default) or `s3` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | S3-compatible storage. Uploads and downloads use presigned URLs directly from the browser. |
| `EDITBOX_MAX_UPLOAD_MB` | Per-file limit (default 51200) |
| `EDITBOX_AGENT_KEYS` | `name:secret,name2:secret2`. Agent API keys (secret at least 16 characters). |
| `EDITBOX_RETENTION_INTERVAL_HOURS` | In-process retention schedule (default 6; 0 disables it) |

### Stripe setup

1. Set `STRIPE_SECRET_KEY` (use a test key first).
2. Add a webhook endpoint `https://<host>/editbox/api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Hour packs are one-off Checkout payments created from `PRICING.packs`. The archive is a subscription Checkout using `STRIPE_ARCHIVE_PRICE_ID`, or an inline monthly price from `PRICING.archive`.
4. Hours are credited only by the verified webhook. Duplicate events are ignored, keyed on the Stripe event ID and session ID.

### Deploying

- **Demo**: deploy the repo as static files. `editbox/` must sit next to `index.html`. The landing page's hero art uses `../assets/e3-timeline.jpg` and falls back to a gradient if `assets/` is not deployed.
- **Live**: run `node editbox/server/server.js` on any Node host (Fly, Render, Railway, a VPS) with a persistent disk for `EDITBOX_DATA_DIR`, or S3/R2 for files. Point `dwimlogic.com/editbox*` at it with a reverse proxy or Cloudflare route, or serve the whole site from it (it serves `/`, `/assets/*` and the favicons). The JSON store is fine for a single-editor studio. Moving to Postgres means keeping the same document shape (see the data model below).

## Pricing placeholders

All in `editbox/static/core.js`. Edit them there and both demo and live update.

```js
PRICING.packs = [
  { id: 'p5',  label: 'Starter',    hours: 5,  priceCents: 47500 },   // $95/hr
  { id: 'p10', label: 'Standard',   hours: 10, priceCents: 90000 },   // $90/hr
  { id: 'p20', label: 'Production', hours: 20, priceCents: 170000 },  // $85/hr
  { id: 'p40', label: 'Studio',     hours: 40, priceCents: 320000 }   // $80/hr
];
PRICING.minStartHours = 5;            // floor for "minimum to start"
PRICING.startShareOfEstimate = 0.5;   // min to start = 50% of the low estimate, rounded up to a pack
PRICING.burnIncrement = 0.25;         // hours are logged in quarter hours
PRICING.archive = { priceCents: 1900, interval: 'month', storageGb: 500 };
```

The preliminary estimate formula (`DELIVERABLES`, `COMPLEXITY`, `RUSH_MULTIPLIER`, `FOOTAGE_REVIEW_PER_HOUR`) sits in the same file. It is a guide only. The editor always confirms or revises it before the client pays.

## Data model

One document per project (`db.projects[]`); the server adds `sessions`, `tokens`, `checkouts`, `uploads` and `events` (processed Stripe event IDs).

```text
Project
  id, title, clientEmail, clientName, createdAt, updatedAt, demo
  status            requested | estimated | active | depleted | archived | purged   (billing lifecycle)
  brief             deliverable, description, footageMinutes, finishedMinutes, versions, complexity, rush, deadline, company,
                    specs { resolution, fps, handoff: render|resolve|xml, captions, notes }
  preliminary       { low, high, minHours }        computed from the brief
  estimate          { low, high, minHours, note, sentAt, by } | null
  ledger[]          { id, type: purchase|burn, hours (+/-), amountCents, packId, source: stripe|mock|demo, ref, note, by, at }
  messages[]        { id, by, role: client|editor|agent|system, body, at, system, kind }   the full project log
  assets[]          { id, kind: source|project|render|deliverable, name, size, type, key (storage, never sent to clients),
                      url (transfer link), uploadedBy, uploaderRole, createdAt, lastUsedAt, ready, warnedAt, purgedAt }
  versions[]        { id, n, label, note, assetId, timelineAssetId, synthetic, durationSec, status: in_review|changes_requested|approved,
                      comments[] { id, t (seconds, null = general), body, by, role, at, resolved }, external { provider, url } }
  work              { state, task, assignee { kind: agent|human, name }, instructions, clientWaiting, updatedAt }
  archive           { status: none|active|canceling|past_due|ended, since, currentPeriodEnd, source, subscriptionId, customerId,
                      declinedAt, endedAt }
  depletedAt, purgeAfter, purgeWarnedAt, purgedAt
  integrations      { blackmagic: { status: interested|invited|connected, library, invitedAt, connectedAt } | null }   Phase 2 hook
```

The balance is always the sum of the ledger, never a stored number.

### Billing lifecycle (`status`)

```text
requested --editor sends estimate--> estimated --client prepays >= minHours--> active
active --hours logged to 0--> depleted (purgeAfter = +14 days)  or  archived (if a subscription is already active)
depleted --archive subscription--> archived          depleted --top up--> active
depleted --client declines archive--> purgeAfter = min(purgeAfter, +7 days)
depleted --purgeAfter passes (retention job)--> purged (files removed; log and ledger kept)
archived --subscription canceled--> runs to period end --> depleted (+7 days) --> purged
```

### Work queue (`work.state`), separate from billing

| State | Meaning | Set by |
|---|---|---|
| `unassigned` | Nobody is on it yet | default |
| `queued_for_agent` | In the agent's inbox with a `task` | editor hand-off, client review, top-up after pause |
| `in_edit` | Claimed (agent) or taken in house (editor) | agent claim, editor |
| `awaiting_client` | A version is out for review | automatically when a version is posted |
| `needs_editor` | Agent escalated, or a human-assigned job came back from review | agent or system |
| `paused_no_hours` | No prepaid hours: handed over before payment, or the balance hit zero | system |
| `done` | Editor closed it out | editor |

Tasks: `first_cut`, `revision`, `deliver_finals`, `reply`. When the client requests changes, an agent-assigned job goes back to `queued_for_agent` with `task: revision`. On approval it goes back with `task: deliver_finals`. `clientWaiting` is set when the client writes last.

## Retention rules and job

Implemented in `core.runRetention(db, now, {dryRun})`. It is pure: it mutates the data and returns the storage keys to delete. The server deletes them from disk or S3 and runs the job every `EDITBOX_RETENTION_INTERVAL_HOURS`. You can also run `npm run retention` from cron or Yan can click **Run now** in the studio.

| Rule | Window (`RETENTION`) |
|---|---|
| Source footage is removed after this many days **without use**, whatever the project state, archive or not | `sourceUnusedDays: 30` (warning at 7 days left) |
| "Use" means an editor or agent opening or downloading the source, or logging hours on the project | |
| An active archive subscription keeps **everything except source footage** (project files, renders, finals) for as long as it is active | |
| Hours used up and no subscription: project files are removed after | `depletedGraceDays: 14` (reminder 3 days before) |
| Client declines the archive: download window, then removal | `declinedDownloadDays: 7` |
| Canceled subscription: runs to the paid period end, then | `lapsedArchiveGraceDays: 7` |
| On purge, files are deleted; the message log, versions with notes, and hour ledger stay as the record. The client can start a new project any time. | |

Every removal and warning is written into the project thread, so the client sees why.

## Agent workflow (Grok Bot, Cursor agents)

The agent is a first-class actor (`role: agent`). It authenticates with `Authorization: Bearer <secret>` from `EDITBOX_AGENT_KEYS` and **only sees jobs handed to it by name**.

The agent can read the job packet, claim it, post messages, upload renders, project files and finals, post versions, log hours, and set `in_edit`, `awaiting_client` or `needs_editor`. It cannot send estimates, take payments, change the archive, or see other jobs.

### Loop

```text
Yan (studio): Send estimate → client prepays → Hand to agent (task, instructions)
Agent:  GET  /editbox/api/agent/jobs                         inbox: queued_for_agent / in_edit / client waiting
        GET  /editbox/api/agent/jobs/:id                     job packet (JSON)   ?format=md for Markdown
        POST /editbox/api/agent/jobs/:id/claim               work.state = in_edit
        download media[].url  (Bearer header for local storage; presigned for S3)
        … edit in DaVinci Resolve to brief.specs …
        POST /editbox/api/projects/:id/uploads               {name,size,type,kind:"render"} → {asset, upload}
        PUT  upload.absoluteUrl  (raw file body)
        POST /editbox/api/projects/:id/assets/:assetId/complete
        (optional) upload the .drp / XML as kind "project" and pass it as timelineAssetId
        POST /editbox/api/projects/:id/versions              {label, note, assetId, durationSec, timelineAssetId}
        POST /editbox/api/projects/:id/burn                  {hours, note}  (quarter hours; stops at the balance)
        POST /editbox/api/projects/:id/messages              {body}
        POST /editbox/api/projects/:id/work                  {state:"needs_editor", note} to escalate to Yan
Client: reviews, pins notes, requests changes → job returns to the agent inbox as task "revision"
```

```bash
KEY=…; BASE=https://dwimlogic.com/editbox/api
curl -s -H "Authorization: Bearer $KEY" $BASE/agent/jobs
curl -s -H "Authorization: Bearer $KEY" "$BASE/agent/jobs/prj_123?format=md"
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"hours":1.5,"note":"Assembly in Resolve"}' $BASE/projects/prj_123/burn
```

### Job packet (`schema: editbox.job/1`)

`project`, `work` (state, task, instructions from Yan, clientWaiting), `brief`, `delivery` (resolution, fps, captions, handoff `render|resolve|xml`, notes, `nle: "DaVinci Resolve"`), `hours` (balance, bought, used, increment, estimate), `media[]` (id, kind, name, size, `url` or `transferLink`), `messages[]` (the full log, including system events), `versions[]` with all notes, `openNotes[]` on the latest version, `blackmagic` (Phase 2 hook), and `api` (the endpoints above). Yan can preview the exact packet from the studio (**View job packet**, Markdown or JSON).

### Resolve-first delivery

The MVP assumes the agent (or Yan) works in DaVinci Resolve locally: it pulls the media, builds the timeline, renders review versions to the delivery spec and uploads them. When the brief asks for `resolve` or `xml` handoff, the agent also uploads the `.drp` export or an XML/FCPXML/AAF timeline as a `project` asset with the final renders (`deliverable`). Resolve automation can use Resolve's scripting API (Python/Lua) for project creation, media import, render queue and export. That lives on the agent side, outside this repo.

### Demo hooks

In demo mode the studio shows **Simulate agent run** for agent-assigned jobs. It runs the agent's side of the loop through the same core ops: claim, post a thread message, post a version (a synthetic demo render), log hours, or, for `deliver_finals`, add a final deliverable. **View job packet** shows the packet an agent would receive.

## Phase 2: Blackmagic Cloud shared project library (not in the MVP)

The goal: the client **invites DWIM Logic / The Edit Box into their shared Blackmagic Cloud / DaVinci Resolve project library** (the server database). We take over the edit inside that shared project, and the client can **watch the timeline being built remotely** through Resolve's live collaboration, instead of only reviewing rendered uploads.

Phase 2 flow:

1. **Invite.** The client indicates Blackmagic Cloud use (the request form already records this as `integrations.blackmagic.status = "interested"`), then invites the DWIM Logic Blackmagic Cloud account to their project library. The studio records `invited`, then `connected` with the library and project names.
2. **Join.** Yan's Resolve (or the agent's Resolve workstation) connects to the shared library. Media stays in the client's Blackmagic Cloud / Cloud Store workflow, so less needs uploading to The Edit Box.
3. **Edit in the shared project.** Yan or the agent builds the timeline in the client's project. Hours are still logged in The Edit Box ledger, and the thread stays the communication log.
4. **Client watches remotely.** The client opens the same project in their Resolve and sees the timeline update. Notes can still be left in The Edit Box with timestamps.
5. **Optional archive push.** Final renders (and a `.drp` snapshot) are still uploaded into The Edit Box as `deliverable` and `project` assets, so they fall under the archive subscription and retention rules.

Hooks already in the MVP: `project.integrations.blackmagic`, `version.external` (a Blackmagic Cloud or Resolve review link per version, shown in the review screen), the Blackmagic interest checkbox on the request form, and Phase 2 copy on the landing page and review screen. Nothing connects to Blackmagic yet. Before building it, check what Blackmagic currently exposes for invitations and library access; this likely starts as a manual invite plus links recorded in the studio, with automation only where Resolve scripting allows it.

## Security notes

- Projects are private: clients see only projects where `clientEmail` matches their session, agents only jobs handed to them, editors everything. Enforced in `core.canSee`, used by every op.
- Sessions use HttpOnly SameSite=Lax cookies (Secure on https). Every cookie-authenticated POST must carry the `X-EditBox: 1` header. Magic links are single-use, expire after 20 minutes, are rate-limited and stored hashed.
- Storage keys never leave the server. Files are served through access-checked routes or short-lived presigned URLs. Static serving is a whitelist, so `editbox/server`, `editbox/data` and `.git` are never served.
- Hours are credited only by a verified Stripe webhook (or the labelled mock checkout when Stripe is not configured, which records amount 0). There are no fake charges anywhere.

## Files

```text
editbox/
  index.html                landing page
  portal/index.html         client portal
  studio/index.html         editor studio
  static/core.js            business rules shared by browser and server (pricing, estimate, ledger, work queue, retention, job packet)
  static/store.js           DemoStore (localStorage/IndexedDB) and LiveStore (API)
  static/app.js             portal and studio UI
  static/player.js          review player (video or synthetic demo render, timecode, note markers)
  static/editbox.css        styles matching the DWIM Logic site
  static/config.js          demo default; replaced by the live server
  static/og.png             social preview image
  server/server.js          HTTP server, auth, API, uploads, Stripe, agent endpoints
  server/{env,db,storage,stripe,mail,retention}.js
  test/*.test.js            node:test suites
  .env.example
```
