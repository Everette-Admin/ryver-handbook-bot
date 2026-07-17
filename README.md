# Ryver Handbook Bot

A single-purpose Q&A bot: an employee messages it a question, it finds the
employee handbook in the **TBR Training / Development** shared drive, pulls
the relevant sections, and answers **only from what the handbook actually
says** (it won't guess).

This is a test build — run it on a test Ryver team first.

---

## How it works (the 30-second version)

Think of it like a parts lookup at the counter: someone asks "what's the
torque spec," the bot goes to the one manual on the shelf (the handbook),
finds the right page, and reads back what's printed — it doesn't make up a
number. If the manual doesn't cover it, it says so.

```
Employee messages bot in Ryver
        │
        ▼
Ryver OUTGOING webhook  ──POST──►  This app (on Railway)
                                        │
                                        ├─ pulls handbook from Google Drive
                                        ├─ finds sections relevant to the question
                                        ├─ asks Claude to answer from those sections
                                        │
                                        ▼
                                  Ryver INCOMING webhook  ◄── answer posted back
```

---

## Setup

There are four things to set up. Do them in this order. Steps 1–2 are the
only fiddly part; take them slow.

### 1. Google Cloud service account (the bot's Drive login)

A "service account" is a robot Google account the bot logs in as. You create
it once, download a key file, and share the handbook's drive with it.

1. Go to **https://console.cloud.google.com** and sign in with a company
   Google account.
2. Top bar, click the project dropdown → **New Project**. Name it something
   like `tbr-handbook-bot`. Create it, then make sure it's selected in the
   dropdown.
3. Left menu (or search bar): go to **APIs & Services → Library**. Search
   **Google Drive API**, click it, click **Enable**.
4. Left menu: **APIs & Services → Credentials**.
5. Click **+ Create Credentials → Service account**.
   - Service account name: `handbook-bot`. Click **Create and Continue**.
   - "Grant this service account access to project" — skip it, click
     **Continue**, then **Done**.
6. You're back on the Credentials page. Under **Service Accounts**, click the
   one you just made (`handbook-bot@...`).
7. Go to the **Keys** tab → **Add Key → Create new key → JSON → Create**.
   A `.json` file downloads. **This is the key. Keep it private — it's the
   bot's password.** You'll paste its contents into Railway in step 3.
8. Copy the service account's email address (looks like
   `handbook-bot@tbr-handbook-bot.iam.gserviceaccount.com`). You need it next.

### 2. Share the handbook drive with the service account

1. In Google Drive, open **Shared drives** and find **TBR Training /
   Development**.
2. Right-click it → **Manage members** (or the member icon at top right).
3. Paste the service account email from step 1.8.
4. Set its role to **Viewer** (read-only — the bot never needs to write).
5. Add / Send.

That's it — the bot can now read anything in that drive, including the
handbook, wherever it sits.

> **Why Viewer and why this drive only:** the bot only ever reads, and only
> this one drive is shared with it. It has zero access to anything else in
> your Google Workspace. This matches the standing rule from the resource
> library scope — nothing sensitive gets exposed.

### 3. Deploy to Railway

1. Put this project in a GitHub repo (see "Pushing to GitHub" below if you
   need it).
2. At **https://railway.app**, sign in → **New Project → Deploy from GitHub
   repo** → pick the repo.
3. Railway auto-detects Node and runs `npm start`. Let it build once (it'll
   fail to fully work until you add variables — that's expected).
4. Open the service → **Variables** tab. Add each variable from
   `.env.example`:
   - `ANTHROPIC_API_KEY` — your Anthropic key.
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — open the `.json` file from step 1.7 in a
     text editor, copy **everything**, paste it as the value.
   - `HANDBOOK_NAME` — a distinctive part of the handbook's filename, e.g.
     `handbook` or `employee handbook`.
   - `RYVER_WEBHOOK_TOKEN` — make up a long random string.
   - `RYVER_INBOUND_URL` — fill this in after step 4 below.
5. After adding variables, Railway redeploys. Under **Settings → Networking**,
   click **Generate Domain** to get a public HTTPS URL like
   `https://tbr-handbook-bot-production.up.railway.app`. Copy it.
6. Visit that URL in a browser — you should see "Ryver handbook bot is
   running." That confirms it's live.

### 4. Wire up Ryver (on your TEST team)

Two webhooks: one so Ryver can *reach* the bot (outgoing), one so the bot can
*reply* (incoming).

**Incoming (bot's replies land here):**
1. In your test Ryver team, pick or create a channel for testing.
2. Channel settings → **Integrations → Incoming Webhook → Add**.
3. Copy the webhook URL it gives you → paste into Railway as
   `RYVER_INBOUND_URL` → save (Railway redeploys).

**Outgoing (Ryver pings the bot when someone asks a question):**
1. Same channel → **Integrations → Outgoing Webhook → Add**.
2. Set the URL to your Railway domain + `/ryver` + the token, e.g.:
   `https://tbr-handbook-bot-production.up.railway.app/ryver?token=YOUR_RYVER_WEBHOOK_TOKEN`
   (use the same value you set for `RYVER_WEBHOOK_TOKEN`).
3. Set it to trigger on messages (and, if offered, on a keyword or mention so
   it doesn't fire on every message in the channel).
4. Save.

### Test it
In the test channel, post a question the handbook answers — e.g.
"how many sick days do we get?" Within a few seconds the bot should reply
with the answer drawn from the handbook. Check Railway's **Deploy logs** if
nothing comes back; the app logs which file it loaded and the question it saw.

---

## Pushing to GitHub (if you need it)

```bash
cd ryver-handbook-bot
git init
git add .
git commit -m "Ryver handbook bot"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR-USER/ryver-handbook-bot.git
git branch -M main
git push -u origin main
```

The `.gitignore` already keeps `node_modules`, `.env`, and any service-account
JSON out of the repo. **Never commit the service account key.**

---

## Notes & limits (worth knowing)

- **Retrieval is keyword-based**, not AI embeddings. Simple and cheap, and
  fine for one handbook. If you notice it occasionally pulling the wrong
  section on vaguely-worded questions, that's the ceiling of this approach —
  the upgrade path is swapping `src/retrieve.js` for an embedding index. The
  rest of the app doesn't change.
- **The bot answers only from the handbook.** If a policy isn't in there, it
  says it can't find it rather than guessing. That's deliberate for a policy
  bot — a confident wrong answer about PTO is worse than "check with HR."
- **Handbook edits show up within ~30 min** (the cache TTL). Change
  `CACHE_TTL_MS` if you want it faster/slower.
- **Free vs paid Railway:** the paid tier avoids idle spin-down. On a test
  team that's optional.

## Files
- `src/index.js` — web server, Ryver webhook handling, handbook cache
- `src/drive.js` — finds + downloads + extracts handbook text from Drive
- `src/retrieve.js` — chunking + keyword retrieval
- `src/answer.js` — the Claude call that writes the answer
