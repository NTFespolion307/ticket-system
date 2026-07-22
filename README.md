# IT Ticket System

A small, self-contained ticket tracker for internal/local use. Clients, tickets,
priorities, statuses — backed by SQLite.

## Running it

Requires **Node.js 22.5 or newer** (24 recommended). There are **no dependencies**
and no `npm install` step — the app uses Node's built-in `node:sqlite` and
`node:http` modules.

```sh
node server.js
```

Then open <http://localhost:3000>.

On first run `tickets.db` is created next to `server.js` and the schema is applied
automatically.

To start over, stop the server and delete **`tickets.db` along with its
`tickets.db-wal` and `tickets.db-shm` siblings** — the database runs in WAL mode,
and leaving a stale `-wal` file next to a fresh `tickets.db` makes SQLite fail
with `disk I/O error`:

```sh
rm -f tickets.db tickets.db-wal tickets.db-shm     # or: del tickets.db*
```

Options:

```sh
PORT=8080 node server.js          # different port (default 3000)
DB_FILE=archive.db node server.js # different database file
```

## Files

| File                | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `server.js`         | HTTP server, JSON API, server-side validation, migrations |
| `schema.sql`        | Table definitions, indexes, `updated_at` trigger, FTS index |
| `ai-client.js`      | The only file that talks to an LLM — swap providers here |
| `public/index.html` | The whole frontend — HTML, CSS and JS in one file |

## API

| Method  | Path               | Notes                                     |
| ------- | ------------------ | ----------------------------------------- |
| `GET`   | `/api/clients`     | All clients, with a ticket count each     |
| `POST`  | `/api/clients`     | `first_name`, `last_name`, `phone_1` required |
| `GET`   | `/api/clients/:id` | One client                                |
| `PATCH` | `/api/clients/:id` | Partial update — send only what changed   |
| `GET`   | `/api/tickets`     | `?status=` `?priority=` `?q=` `?sort=`    |
| `POST`  | `/api/tickets`     | `title` and a valid `client_id` required  |
| `GET`   | `/api/tickets/:id` | One ticket, joined with client contact    |
| `PATCH` | `/api/tickets/:id` | Partial update — send only what changed   |
| `GET`   | `/api/tickets/:id/steps`   | Diagnostic step log, oldest first |
| `POST`  | `/api/tickets/:id/steps`   | Add a step — `{ stepText }`       |
| `PATCH` | `/api/tickets/:id/resolve` | `{ solutionSummary, solutionCategory? }` — summary required |
| `PATCH` | `/api/tickets/:id/reopen`  | Back to Open; keeps `solution_summary` |
| `POST`  | `/api/tickets/suggest`     | `{ title, description, deviceModel? }` → suggested fixes |
| `GET`   | `/api/solution-categories` | Fixed list plus categories already used |

Validation errors come back as `400` with `{ "errors": ["...", "..."] }`.

### Ticket ordering (`?sort=`)

| Value      | Order                                                                |
| ---------- | -------------------------------------------------------------------- |
| `smart`    | **Default.** Active first, then priority, then newest — Resolved and Closed always sink to the bottom |
| `priority` | Priority only, so a Critical ticket leads even if it's closed         |
| `status`   | Open → In Progress → Resolved → Closed, priority within each          |
| `newest`   | Newest first                                                          |
| `oldest`   | Oldest first                                                          |

An unknown or missing value falls back to `smart`.

## AI-assisted diagnosis

Three pieces that feed each other: techs log **diagnostic steps** while they
work, **resolving** a ticket captures the fix that actually worked, and new
tickets get **suggested fixes** drawn from that accumulated history.

### Diagnostic steps

Open a ticket and use the **Diagnostic steps** box under the description. Steps
are timestamped and appended without a page reload, and stay usable from
creation right through resolution and after a reopen. They are the richest
matching signal — the reasoning, not just the one-line answer — so the search
indexes them alongside the symptom and the fix.

### Resolve / Reopen

**Resolve…** (on the ticket row or inside the ticket) opens a dialog asking what
fixed it. The summary is **required** — the API rejects a resolve without one —
because it is what future suggestions are built from. An optional category is
offered from a fixed list merged with categories already used.

Once resolved the button becomes **Reopen**, which returns the ticket to Open and
clears `resolved_at` but **keeps `solution_summary`**: it is history, and it
pre-fills the dialog if the ticket is resolved again.

### Suggested fixes

While a tech types a title/description, a panel below the form shows likely
fixes, 600ms after typing stops and only once there is enough to match on. It is
advisory only — it never blocks submitting and never writes into the form.

Each result is labelled by source, so "our past fixes" is never confused with
"the model's general knowledge":

| Badge | Meaning |
| --- | --- |
| **based on N similar past tickets** | grounded in this shop's own resolved tickets |
| **general suggestion — no matching history yet** | the model's own troubleshooting knowledge |
| **no matching history yet** | nothing found and no AI configured |

Matching uses SQLite **FTS5 with `bm25()` ranking** (the equivalent of MySQL's
`MATCH … AGAINST`) over each resolved ticket's title, description, device,
solution **and full step log**, with same-device tickets boosted to the top. Only
tickets that are Resolved/Closed *and* have a recorded solution are ever offered.

### Configuring the AI

A **`.env` file is already in the project folder** — open it, paste your key
after `AI_API_KEY=`, and restart the server:

```ini
AI_API_KEY=sk-ant-api03-xxxxxxxx
```

Get a key at <https://console.anthropic.com/settings/keys>. The startup banner
confirms it was picked up (`AI suggestions: claude (claude-opus-4-8)`). The file
is read from the project folder regardless of where you start the server from,
and it is listed in `.gitignore` so the key is never committed.

Everything below is optional — **with no key the app still works** and the panel
shows this shop's own aggregated past fixes, labelled `history`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | — | Key for the selected provider (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` also accepted) |
| `AI_PROVIDER` | `claude` | `claude`, `gemini`, or `none` (disables the LLM) |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Gemini model override |
| `CLAUDE_MODEL` | `claude-opus-4-8` | Claude model override |
| `AI_MODEL` | — | Generic override; **ignored with a warning if it doesn't match the provider** |
| `AI_BASE_URL` | provider default | Point at a gateway/proxy, or a test double |

### Choosing a provider

| | Claude | Gemini |
| --- | --- | --- |
| Key from | [console.anthropic.com](https://console.anthropic.com/settings/keys) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Cost | needs purchased API credits | has a free tier |
| Default model | `claude-opus-4-8` | `gemini-flash-lite-latest` |

Switching is one line in `.env` (`AI_PROVIDER=gemini`). A model id belongs to
exactly one provider, so use `GEMINI_MODEL` / `CLAUDE_MODEL` rather than the
generic `AI_MODEL` — a leftover `AI_MODEL=claude-…` would otherwise be sent to
Google and fail confusingly. The app now ignores such a mismatch and warns.

**On Gemini model choice:** the default is the floating `…-latest` alias
deliberately — pinned Gemini versions get closed off to new accounts (that is
exactly why `gemini-2.5-flash` returns *"no longer available to new users"*).
It is the **lite** tier because this endpoint fires while a tech types:
measured round-trip was **~1.7s for lite vs ~9s for full flash**, and the lite
models were also the ones that correctly merged near-duplicate past fixes.

```sh
# .env
AI_API_KEY=sk-ant-...
```

The startup banner tells you which mode you're in. **Adding a provider** means
adding one entry to `PROVIDERS` in `ai-client.js` — nothing in `server.js` or the
frontend knows which provider is behind `getSuggestion()`. If the provider errors
or times out (20s), the endpoint still returns 200 with the historical tally, so
ticket creation is never blocked by the AI being down.

If the provider errors, the panel now says **why** (e.g. *"Your credit balance is
too low… Add API credits at console.anthropic.com → Plans & Billing"*) rather
than a bare "unavailable", and still lists this shop's own past fixes.

## Database migrations

There is no migration CLI — `server.js` migrates on startup and is safe to run
repeatedly:

| Change | What happens |
| --- | --- |
| `solution_summary`, `solution_category`, `resolved_at`, `resolved_by` on `tickets` | added via `ALTER TABLE` if missing (nullable, so existing rows stay valid) |
| `ticket_steps` table | created if missing |
| `ticket_search` FTS5 index | created if missing, and rebuilt from scratch on every start |

Existing tickets and clients are left untouched. This is covered by a test that
builds a database in the *previous* schema, boots the new server against it, and
checks nothing was lost.

## Printing a ticket

Every row in the tickets list has a **Print** button at its right edge — one
click, no need to open the ticket first. It lays the ticket out as a one-page
work order and opens the browser's print dialog; choosing *Save as PDF* as the
destination gives you the PDF, so the app needs no PDF library.

The sheet carries the full ticket (title, status, priority, dates, brand, model,
password, description, steps to reproduce), the client's name, both phones and
email, a blank **3x3 unlock-pattern grid** to draw a phone's pattern on, the
repair total, and signature lines. Empty fields print as short dotted rules so
they can be filled in by hand.

It is built to be printed all day, so it is **compact**: the whole work order is
a framed card in the top half of the page — two tight columns, no section header
bars, no per-row rules. The frame is the line to guillotine along, and it comes
out the same size every time (128mm; a very wordy ticket reaches ~139mm, still
inside the half-page fold).

Ink is kept down throughout: nothing is filled or shaded, the status/priority
pills and the pattern dots are outlined rather than solid, and hairlines do the
separating. It uses **~half the ink of the original full-page sheet**.

It prints the ticket **as saved** — save your changes first if you've just
edited something.

## Notes

- **Clients are editable** — click any row in the Clients tab (or its **Edit**
  button) to change the name, phones or email. Renaming updates the tickets list
  too, since ticket rows show the client's name. A client keeping its own phone
  number is not treated as a duplicate of itself.
- **One client per phone number.** `phone_1` is required and no two clients may
  share it, so you can't enter the same person twice. The comparison ignores
  formatting — `555-0100`, `555 0100`, `(555) 0100` and `+5550100` are all the
  same number. The error names the client who already has it. `phone_2` is
  optional and unconstrained.
- Two clients *may* still share a name (different people do), and a phone can
  appear as one client's `phone_1` and another's `phone_2` — a shared household
  or office line.
- If you already have a `tickets.db` from before this rule, the server upgrades
  it on the next start. If existing rows break the rule (a client with no phone,
  or two sharing one), it refuses to start and lists exactly which rows to fix
  rather than guessing which to discard.
- A walk-in client can be added without leaving the ticket you're writing: hit
  **+ New** beside the client picker. Anything you already typed into the picker
  is carried into the dialog, and the new client is selected automatically.
- **Repair total** (the `price` column) is what the client is charged for the
  repair — not the value of the device. It prints as a total line at the foot of
  the work order, deliberately away from the brand/model details.
- Each row in the tickets list carries **In Progress**, **Resolve** and **Print**
  buttons. The status buttons apply straight away and grey out when the ticket
  is already in that state; resolving one makes it sink down the list under the
  default sort. There is no Open or Close button — use the dropdown in the
  ticket itself for those.
- **Resolved** is the terminal state in day-to-day use, so it wears the neutral
  grey badge (Closed is a slightly darker grey, still available in the
  dropdowns and filters).
- The **Sort** dropdown sets the list order (see above). Clicking a column header
  still sorts by that one column, and overrides the dropdown until you change it.
- Validation runs on **both** sides. The browser catches missing fields before
  submitting; the server re-checks everything (required fields, enum values,
  numeric price, client existence) and never trusts the client.
- All SQL uses parameterised queries, and all user data is HTML-escaped before
  rendering, so titles and names containing `<` or quotes are safe.
- **No authentication.** Ticket device passwords are stored in plain text so
  technicians can read them back — that is the point of the field, but it means
  anyone who can reach the port or copy `tickets.db` can read them. Keep this
  bound to a trusted machine or LAN; don't expose it to the internet as-is.
