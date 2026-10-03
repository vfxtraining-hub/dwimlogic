# Lead capture setup (Google Apps Script)

What it does: every form on the site (brief, "email me this estimate", partner rate card request) posts to a Google Apps Script web app. The script logs the lead to a Google Sheet, emails you, and, for estimates, emails the visitor a branded copy of their estimate. Prices are recomputed on the server so an email can never show a tampered price.

## Deploy (about 20 minutes)
1. Sign in to the Google account that should own the leads and send the emails (ideally the `hello@dwimlogic.com` account).
2. Create a new Google Sheet named "DWIM Logic Leads".
3. In the sheet: **Extensions → Apps Script**. Delete the sample code and paste all of `Code.gs`.
4. At the top of the script set `OWNER_EMAIL` (where notifications go and where visitor replies land).
5. **Deploy → New deployment → Select type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy**, approve the permissions (Sheets and Gmail sending), and copy the **Web app URL** (it ends in `/exec`).
7. In `site.src.html`, set `var FORM_ENDPOINT='...';` to that URL, then run `python3 build_site.py` and deploy `index.html`.
8. Test: submit each form once. You should see a row in the `Leads` tab and an email for each. For an estimate, the visitor email arrives from your Gmail address.

## After you change the script
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.** The URL stays the same. Pasting new code without redeploying changes nothing for the live site.

## Keeping prices in sync
The rate card lives in two places: `RATES` in `Code.gs` and `var E` in `site.src.html`. Change both together. `node apps-script/test_local.js` runs the script's logic against mocks (pricing tiers, minimums, rush, honeypot, rate limit, who gets which email).

## Limits and safeguards
- Gmail has a daily sending cap for consumer accounts (roughly 100 recipients a day, higher for Google Workspace; check Google's current quota page). Each estimate sends two emails.
- Spam: hidden honeypot field plus a per-email limit of 6 requests an hour.
- Privacy: the forms say the details are used only to reply. Delete rows when asked.
- Free, and the data sits in your own Sheet. To get a visitor copy from `@dwimlogic.com` instead of Gmail later, move to a small Cloudflare function with an email API.
