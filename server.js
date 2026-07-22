/* ============================================================================
 * IT Ticket Management System - backend
 * ============================================================================
 *
 * SETUP
 * -----
 *   Requirements: Node.js 22.5+ (24 LTS recommended). Nothing else.
 *   There are NO dependencies and no `npm install` step -- this uses Node's
 *   built-in `node:sqlite` module and `node:http` server.
 *
 *   Run it:
 *       node server.js
 *
 *   Then open http://localhost:3000
 *
 *   Options (environment variables):
 *       PORT=8080 node server.js      # change the port (default 3000)
 *       DB_FILE=other.db node server.js   # change the db file (default tickets.db)
 *
 *   The SQLite file (tickets.db) is created next to this script on first run
 *   and the schema in schema.sql is applied automatically. To reset everything,
 *   just delete tickets.db and restart.
 *
 * FILES
 * -----
 *   server.js          <- this file: HTTP server + JSON API + validation
 *   schema.sql         <- table definitions
 *   public/index.html  <- the entire frontend (HTML + CSS + JS in one file)
 *
 * API
 * ---
 *   GET    /api/clients            list clients (with ticket counts)
 *   POST   /api/clients            create a client
 *   GET    /api/tickets            list tickets (?status=&priority=&q=)
 *   POST   /api/tickets            create a ticket
 *   GET    /api/tickets/:id        single ticket, with client details
 *   PATCH  /api/tickets/:id        partial update (any subset of fields)
 * ==========================================================================*/

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ai = require('./ai-client');       // the only module that talks to an LLM

const PORT = Number(process.env.PORT) || 80;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'tickets.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------------------------------------------------------------------
 * Database
 * ------------------------------------------------------------------------ */

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * Phone numbers are compared with their separators stripped, so "555-0100",
 * "555 0100" and "(555) 0100" all count as the same number.
 * MUST stay identical to the unique index expression in schema.sql.
 */
const PHONE_KEY = (col) =>
  `replace(replace(replace(replace(replace(replace(
     ${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')`;

/** The JavaScript twin of PHONE_KEY. */
const phoneKey = (value) => String(value ?? '').replace(/[\s\-().+]/g, '');

/**
 * phone_1 became required and unique after the first release. A database made
 * before that keeps its old, laxer table definition (CREATE TABLE IF NOT EXISTS
 * will not change it), so rebuild it here. Runs before schema.sql so the unique
 * index is only created once the data can actually satisfy it.
 */
function migrateClientsPhone() {
  const columns = db.prepare('PRAGMA table_info(clients)').all();
  const phone = columns.find((c) => c.name === 'phone_1');
  if (!phone || phone.notnull === 1) return;      // brand new db, or already done

  const blank = db
    .prepare(`SELECT id, first_name, last_name FROM clients
              WHERE phone_1 IS NULL OR trim(phone_1) = ''`)
    .all();
  const dupes = db
    .prepare(`SELECT group_concat(id) AS ids, phone_1
              FROM clients WHERE phone_1 IS NOT NULL AND trim(phone_1) <> ''
              GROUP BY ${PHONE_KEY('phone_1')} HAVING count(*) > 1`)
    .all();

  // Refuse to guess which row to keep -- tell the user what to fix.
  if (blank.length || dupes.length) {
    console.error('\n  Cannot start: phone 1 is now required and must be unique,');
    console.error('  but the existing database breaks those rules:\n');
    for (const c of blank) {
      console.error(`    - client #${c.id} (${c.first_name} ${c.last_name}) has no phone 1`);
    }
    for (const d of dupes) {
      console.error(`    - clients ${d.ids} all share the phone number ${d.phone_1}`);
    }
    console.error('\n  Edit those rows, or delete the database file to start fresh.\n');
    process.exit(1);
  }

  console.log('  Upgrading clients.phone_1 to NOT NULL + UNIQUE...');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    BEGIN;
    CREATE TABLE clients_migrated (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL CHECK (length(trim(first_name)) > 0),
      last_name  TEXT NOT NULL CHECK (length(trim(last_name))  > 0),
      phone_1    TEXT NOT NULL CHECK (length(trim(phone_1))    > 0),
      phone_2    TEXT,
      email      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO clients_migrated (id, first_name, last_name, phone_1, phone_2, email, created_at)
      SELECT id, first_name, last_name, phone_1, phone_2, email, created_at FROM clients;
    DROP TABLE clients;
    ALTER TABLE clients_migrated RENAME TO clients;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
 * add them to a database that already exists, so add them here. Each is
 * nullable with no default, so existing rows stay valid untouched.
 */
function migrateTicketSolutionColumns() {
  const columns = db.prepare('PRAGMA table_info(tickets)').all();
  if (!columns.length) return;                       // brand new db; schema.sql handles it

  const have = new Set(columns.map((c) => c.name));
  const wanted = [
    ['solution_summary', 'TEXT'],
    ['solution_category', 'TEXT'],
    ['resolved_at', 'TEXT'],
    ['resolved_by', 'INTEGER'],
  ];
  for (const [name, type] of wanted) {
    if (!have.has(name)) {
      console.log(`  Adding tickets.${name}...`);
      db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${type};`);
    }
  }
}

migrateClientsPhone();
migrateTicketSolutionColumns();
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// node:sqlite returns INTEGER columns as JS numbers, but lastInsertRowid can be
// a BigInt -- JSON.stringify chokes on those, so normalise before responding.
const toNum = (v) => (typeof v === 'bigint' ? Number(v) : v);

/* ---------------------------------------------------------------------------
 * Full-text search index
 *
 * One ticket_search row per ticket. Rebuilt whenever a ticket or one of its
 * diagnostic steps changes -- explicit calls rather than SQL triggers, because
 * the indexed text aggregates a second table (ticket_steps) and a trigger
 * would have to re-aggregate it on every step insert.
 * ------------------------------------------------------------------------ */

function reindexTicket(id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  db.prepare('DELETE FROM ticket_search WHERE ticket_id = ?').run(id);
  if (!t) return;

  const steps = db
    .prepare('SELECT step_text FROM ticket_steps WHERE ticket_id = ? ORDER BY id')
    .all(id)
    .map((s) => s.step_text);

  // The step log carries the diagnostic reasoning, so it is weighted into the
  // searchable body alongside the symptom text.
  const body = [t.description, t.steps_to_reproduce, t.brand, t.model, ...steps]
    .filter(Boolean)
    .join('\n');

  db.prepare('INSERT INTO ticket_search (ticket_id, title, body, solution) VALUES (?, ?, ?, ?)')
    .run(id, t.title || '', body, t.solution_summary || '');
}

/** Rebuild the whole index -- cheap, and keeps a migrated db consistent. */
function reindexAll() {
  db.exec('DELETE FROM ticket_search;');
  for (const { id } of db.prepare('SELECT id FROM tickets').all()) reindexTicket(id);
}

reindexAll();

/* ---------------------------------------------------------------------------
 * Validation helpers -- the backend never trusts the frontend's checks.
 * ------------------------------------------------------------------------ */

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];

/** Trim a value to a string, or return null for empty/absent optional fields. */
function str(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Parse an optional decimal. Returns undefined when the value is invalid. */
function decimal(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Validate client input.
 * @param {object}  body
 * @param {object}  opts
 * @param {boolean} opts.partial    true for PATCH -- only check the keys present.
 * @param {number}  opts.excludeId  the client being edited, so its own phone
 *                                  number does not count as a duplicate of itself.
 */
function validateClient(body, { partial = false, excludeId = null } = {}) {
  const errors = [];
  const values = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('first_name')) {
    const first_name = str(body.first_name);
    if (!first_name) errors.push('First name is required.');
    else values.first_name = first_name;
  }

  if (!partial || has('last_name')) {
    const last_name = str(body.last_name);
    if (!last_name) errors.push('Last name is required.');
    else values.last_name = last_name;
  }

  if (!partial || has('phone_1')) {
    const phone_1 = str(body.phone_1);
    if (!phone_1) {
      errors.push('Phone 1 is required.');
    } else if (!/\d/.test(phone_1)) {
      errors.push('Phone 1 must contain at least one digit.');
    } else {
      // One client per phone number. Naming the existing client is far more
      // useful than "duplicate phone" on its own.
      const clash = db
        .prepare(`SELECT id, first_name, last_name FROM clients
                  WHERE ${PHONE_KEY('phone_1')} = ? AND id IS NOT ?`)
        .get(phoneKey(phone_1), excludeId);
      if (clash) {
        errors.push(`Phone ${phone_1} already belongs to ` +
          `${clash.first_name} ${clash.last_name} (client #${clash.id}).`);
      } else {
        values.phone_1 = phone_1;
      }
    }
  }

  if (!partial || has('email')) {
    const email = str(body.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Email is not a valid address.');
    } else {
      values.email = email;
    }
  }

  if (!partial || has('phone_2')) values.phone_2 = str(body.phone_2);

  return { errors, values };
}

/**
 * Validate ticket input.
 * @param {object} body
 * @param {boolean} partial  true for PATCH -- only validate the keys present.
 */
function validateTicket(body, partial = false) {
  const errors = [];
  const values = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('title')) {
    const title = str(body.title);
    if (!title) errors.push('Title is required.');
    else values.title = title;
  }

  if (!partial || has('client_id')) {
    const clientId = Number(body.client_id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      errors.push('A client must be selected.');
    } else {
      const exists = db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId);
      if (!exists) errors.push(`Client #${clientId} does not exist.`);
      else values.client_id = clientId;
    }
  }

  if (!partial || has('priority')) {
    const priority = str(body.priority) ?? 'Low';
    if (!PRIORITIES.includes(priority)) {
      errors.push(`Priority must be one of: ${PRIORITIES.join(', ')}.`);
    } else values.priority = priority;
  }

  if (!partial || has('status')) {
    const status = str(body.status) ?? 'Open';
    if (!STATUSES.includes(status)) {
      errors.push(`Status must be one of: ${STATUSES.join(', ')}.`);
    } else values.status = status;
  }

  if (!partial || has('price')) {
    const price = decimal(body.price);
    if (price === undefined) errors.push('Price must be a positive number.');
    else values.price = price;
  }

  for (const field of ['description', 'steps_to_reproduce', 'brand', 'model', 'password']) {
    if (!partial || has(field)) values[field] = str(body[field]);
  }

  return { errors, values };
}

/* ---------------------------------------------------------------------------
 * Route handlers
 * ------------------------------------------------------------------------ */

const TICKET_SELECT = `
  SELECT t.*,
         c.first_name || ' ' || c.last_name AS client_name,
         c.email  AS client_email,
         c.phone_1 AS client_phone_1,
         c.phone_2 AS client_phone_2
  FROM tickets t
  JOIN clients c ON c.id = t.client_id
`;

/* ---------------------------------------------------------------------------
 * Ticket ordering
 *
 * These are SQL fragments picked by key from ?sort= -- the value from the query
 * string is only ever used to look up a key here, never interpolated into SQL.
 * ------------------------------------------------------------------------ */

const PRIORITY_ORDER = `CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1
                                        WHEN 'Medium'   THEN 2 ELSE 3 END`;
const STATUS_ORDER = `CASE t.status WHEN 'Open'     THEN 0 WHEN 'In Progress' THEN 1
                                    WHEN 'Resolved' THEN 2 ELSE 3 END`;
// Resolved and Closed tickets are finished work -- they always sink below the
// active ones, no matter how urgent they were.
const DONE_LAST = `CASE WHEN t.status IN ('Resolved', 'Closed') THEN 1 ELSE 0 END`;

const SORTS = {
  // Default: active tickets first, most urgent at the top, newest as tiebreak.
  smart:    `${DONE_LAST}, ${PRIORITY_ORDER}, ${STATUS_ORDER}, t.created_at DESC`,
  // Priority only -- a Critical ticket leads even if it is already closed.
  priority: `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.created_at DESC`,
  status:   `${STATUS_ORDER}, ${PRIORITY_ORDER}, t.created_at DESC`,
  newest:   `t.created_at DESC, t.id DESC`,
  oldest:   `t.created_at ASC, t.id ASC`,
};
const DEFAULT_SORT = 'smart';

const routes = {
  'GET /api/clients': () =>
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.client_id = c.id) AS ticket_count
         FROM clients c
         ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`
      )
      .all(),

  'POST /api/clients': (body) => {
    const { errors, values } = validateClient(body);
    if (errors.length) return { status: 400, body: { errors } };

    let info;
    try {
      info = db
        .prepare(
          `INSERT INTO clients (first_name, last_name, phone_1, phone_2, email)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(values.first_name, values.last_name, values.phone_1, values.phone_2, values.email);
    } catch (err) {
      // The unique index is the real guarantee; the check above is only there
      // to produce a friendlier message. Translate it rather than leaking SQL.
      if (/UNIQUE constraint failed/.test(err.message)) {
        return { status: 409, body: { errors: ['That phone number is already on another client.'] } };
      }
      throw err;
    }

    const id = toNum(info.lastInsertRowid);
    return {
      status: 201,
      body: db.prepare('SELECT * FROM clients WHERE id = ?').get(id),
    };
  },

  'GET /api/tickets': (_body, url) => {
    const where = [];
    const params = [];

    const status = url.searchParams.get('status');
    if (status && STATUSES.includes(status)) {
      where.push('t.status = ?');
      params.push(status);
    }

    const priority = url.searchParams.get('priority');
    if (priority && PRIORITIES.includes(priority)) {
      where.push('t.priority = ?');
      params.push(priority);
    }

    const q = (url.searchParams.get('q') || '').trim();
    if (q) {
      where.push(`(t.title LIKE ? OR t.brand LIKE ? OR t.model LIKE ?
                   OR c.first_name LIKE ? OR c.last_name LIKE ?)`);
      params.push(...Array(5).fill(`%${q}%`));
    }

    let sql = TICKET_SELECT;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    // An unknown or missing ?sort= falls back to the default rather than erroring.
    sql += ' ORDER BY ' + (SORTS[url.searchParams.get('sort')] || SORTS[DEFAULT_SORT]);

    return db.prepare(sql).all(...params);
  },

  'POST /api/tickets': (body) => {
    const { errors, values } = validateTicket(body, false);
    if (errors.length) return { status: 400, body: { errors } };

    const info = db
      .prepare(
        `INSERT INTO tickets
           (title, description, steps_to_reproduce, brand, model,
            client_id, price, password, priority, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        values.title,
        values.description,
        values.steps_to_reproduce,
        values.brand,
        values.model,
        values.client_id,
        values.price,
        values.password,
        values.priority,
        values.status
      );

    const id = toNum(info.lastInsertRowid);
    reindexTicket(id);
    return { status: 201, body: db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) };
  },
};

/* ---------------------------------------------------------------------------
 * Similar-ticket search, and AI suggestions
 * ------------------------------------------------------------------------ */

/**
 * Turn free text into a safe FTS5 query. FTS5 has its own syntax (quotes, NEAR,
 * ^, *, AND/OR) so raw user input must never be passed through -- take the
 * word characters only and OR them together.
 */
function ftsQuery(text) {
  const words = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 2 && !FTS_STOPWORDS.has(w))
    .slice(0, 25);
  return [...new Set(words)].map((w) => `"${w}"`).join(' OR ');
}

const FTS_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'you', 'your', 'its', 'are', 'when', 'from', 'all', 'any', 'can',
  'will', 'his', 'her', 'they', 'them', 'been', 'does', 'did', 'get', 'got',
]);

/**
 * Find resolved tickets that look like the one being typed.
 * SQLite's FTS5 + bm25() is the equivalent of MySQL's MATCH ... AGAINST.
 * A matching device model boosts a ticket to the top of the list.
 */
function findSimilarTickets({ title, description, deviceModel }, limit = 12) {
  const query = ftsQuery(`${title || ''} ${description || ''} ${deviceModel || ''}`);
  if (!query) return [];

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT t.id, t.title, t.description, t.brand, t.model,
                t.solution_summary, t.solution_category, t.status,
                bm25(ticket_search, 4.0, 1.0, 3.0) AS rank
           FROM ticket_search
           JOIN tickets t ON t.id = ticket_search.ticket_id
          WHERE ticket_search MATCH ?
            AND t.status IN ('Resolved', 'Closed')
            AND t.solution_summary IS NOT NULL
          ORDER BY rank
          LIMIT ?`
      )
      .all(query, limit * 2);
  } catch (err) {
    console.error('similar-ticket search failed:', err.message);
    return [];
  }

  const wantedModel = str(deviceModel)?.toLowerCase();
  if (wantedModel) {
    // Boost same-device tickets: a fix for this exact model is worth more than
    // a better text match on a different one.
    rows.sort((a, b) => {
      const am = `${a.brand || ''} ${a.model || ''}`.toLowerCase().includes(wantedModel) ? 0 : 1;
      const bm = `${b.brand || ''} ${b.model || ''}`.toLowerCase().includes(wantedModel) ? 0 : 1;
      return am - bm || a.rank - b.rank;
    });
  }

  const stepsFor = db.prepare(
    'SELECT step_text FROM ticket_steps WHERE ticket_id = ? ORDER BY id LIMIT 20'
  );
  return rows.slice(0, limit).map((r) => ({
    ...r,
    steps: stepsFor.all(r.id).map((s) => s.step_text),
  }));
}

/**
 * Aggregate the matched history without an LLM: group identical fixes and
 * count them. This is the fallback when no AI key is configured, and it is
 * also what the "matchCount" numbers are sanity-checked against.
 */
function tallyHistory(similar) {
  const byFix = new Map();
  for (const s of similar) {
    const fix = (s.solution_summary || '').trim();
    if (!fix) continue;
    const key = fix.toLowerCase();
    const entry = byFix.get(key) || { fix, matchCount: 0 };
    entry.matchCount += 1;
    byFix.set(key, entry);
  }
  return [...byFix.values()]
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, 6)
    .map((e) => ({
      ...e,
      confidence: e.matchCount >= 3 ? 'high' : e.matchCount === 2 ? 'medium' : 'low',
    }));
}

/**
 * POST /api/tickets/suggest -- advisory only, called while the tech types.
 * Never throws to the caller: if the model is unreachable the historical
 * tally is still returned, so the panel degrades instead of disappearing.
 */
async function suggestRoute(body) {
  const title = str(body.title);
  const description = str(body.description);
  const deviceModel = str(body.deviceModel ?? body.device_model);

  // Cheap guard -- the frontend debounces, but never trust it.
  if (`${title || ''} ${description || ''}`.trim().length < 8) {
    return {
      status: 200,
      body: { source: 'none', matchedTickets: 0, topSuggestions: [], warnings: [], generalNotes: '' },
    };
  }

  const similar = findSimilarTickets({ title, description, deviceModel });
  const tally = tallyHistory(similar);

  const base = {
    matchedTickets: similar.length,
    matchedTicketIds: similar.map((s) => s.id),
    aiAvailable: ai.isConfigured(),
  };

  if (!ai.isConfigured()) {
    // No LLM: return the shop's own aggregated history, clearly labelled.
    return {
      status: 200,
      body: {
        ...base,
        source: similar.length ? 'history' : 'none',
        topSuggestions: tally,
        warnings: [],
        generalNotes: similar.length
          ? ''
          : 'No matching past tickets yet. Log diagnostic steps and a solution on each ticket to build this up.',
      },
    };
  }

  try {
    const suggestion = await ai.getSuggestion({
      ticket: { title, description, deviceModel },
      similar,
    });
    return {
      status: 200,
      body: {
        ...base,
        // "history" when the answer is grounded in this shop's tickets,
        // "general" when the model is drawing on its own knowledge.
        source: similar.length ? 'history' : 'general',
        ...suggestion,
      },
    };
  } catch (err) {
    // Say WHY. The provider's own message ("credit balance is too low",
    // "invalid x-api-key") is what makes this fixable without digging.
    console.error('AI suggestion failed:', err.message);
    const reason = err.name === 'AbortError' || /abort/i.test(err.message)
      ? 'The AI provider timed out.'
      : err.message;
    return {
      status: 200,
      body: {
        ...base,
        source: similar.length ? 'history' : 'none',
        topSuggestions: tally,
        warnings: [],
        generalNotes: '',
        aiError: `AI unavailable — showing past fixes only. ${reason}`.trim(),
      },
    };
  }
}

/* ---------------------------------------------------------------------------
 * Diagnostic steps, and the resolve / reopen flow
 * ------------------------------------------------------------------------ */

/** Categories offered in the resolve dialog; past ones are merged in at runtime. */
const SOLUTION_CATEGORIES = [
  'hardware-replacement',
  'hardware-reseat',
  'software-fix',
  'cleaning',
  'data-recovery',
  'no-fault-found',
  'other',
];

/** Fixed list plus whatever categories past tickets actually used. */
function listSolutionCategories() {
  const used = db
    .prepare(
      `SELECT DISTINCT solution_category AS c FROM tickets
        WHERE solution_category IS NOT NULL AND trim(solution_category) <> ''`
    )
    .all()
    .map((r) => r.c);
  return [...new Set([...SOLUTION_CATEGORIES, ...used])].sort();
}

/** Handlers for /api/tickets/:id/steps */
function ticketStepsRoute(method, id, body) {
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
  if (!ticket) return { status: 404, body: { errors: ['Ticket not found.'] } };

  if (method === 'GET') {
    return {
      status: 200,
      body: db
        .prepare('SELECT * FROM ticket_steps WHERE ticket_id = ? ORDER BY id')
        .all(id),
    };
  }

  if (method === 'POST') {
    const stepText = str(body.stepText ?? body.step_text);
    if (!stepText) return { status: 400, body: { errors: ['Step text is required.'] } };
    if (stepText.length > 2000) {
      return { status: 400, body: { errors: ['Step text is limited to 2000 characters.'] } };
    }

    const info = db
      .prepare('INSERT INTO ticket_steps (ticket_id, step_text) VALUES (?, ?)')
      .run(id, stepText);
    reindexTicket(id);          // the step log feeds future similarity matches

    return {
      status: 201,
      body: db.prepare('SELECT * FROM ticket_steps WHERE id = ?').get(toNum(info.lastInsertRowid)),
    };
  }

  return { status: 405, body: { errors: ['Method not allowed.'] } };
}

/**
 * Resolve a ticket. The solution summary is mandatory -- capturing what
 * actually fixed it is the whole point of the flow, and it is what future
 * suggestions are built from.
 */
function resolveTicketRoute(method, id, body) {
  if (method !== 'PATCH' && method !== 'POST') {
    return { status: 405, body: { errors: ['Method not allowed.'] } };
  }
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
  if (!ticket) return { status: 404, body: { errors: ['Ticket not found.'] } };

  const summary = str(body.solutionSummary ?? body.solution_summary);
  const category = str(body.solutionCategory ?? body.solution_category);
  const errors = [];
  if (!summary) errors.push('A solution summary is required to resolve a ticket.');
  else if (summary.length > 500) errors.push('Solution summary is limited to 500 characters.');
  if (errors.length) return { status: 400, body: { errors } };

  db.prepare(
    `UPDATE tickets
        SET status = 'Resolved', solution_summary = ?, solution_category = ?,
            resolved_at = datetime('now')
      WHERE id = ?`
  ).run(summary, category, id);
  reindexTicket(id);

  return { status: 200, body: db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) };
}

/**
 * Reopen a resolved ticket. solution_summary is deliberately kept -- it is
 * history, and it pre-fills the dialog if the ticket is resolved again.
 */
function reopenTicketRoute(method, id) {
  if (method !== 'PATCH' && method !== 'POST') {
    return { status: 405, body: { errors: ['Method not allowed.'] } };
  }
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
  if (!ticket) return { status: 404, body: { errors: ['Ticket not found.'] } };

  db.prepare(`UPDATE tickets SET status = 'Open', resolved_at = NULL WHERE id = ?`).run(id);
  reindexTicket(id);

  return { status: 200, body: db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) };
}

/** Handlers for /api/clients/:id -- matched separately because of the id. */
function clientByIdRoute(method, id, body) {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!existing) return { status: 404, body: { errors: ['Client not found.'] } };

  if (method === 'GET') return { status: 200, body: existing };

  if (method === 'PATCH' || method === 'PUT') {
    const { errors, values } = validateClient(body, {
      partial: method === 'PATCH',
      excludeId: id,          // its own number must not read as a duplicate
    });
    if (errors.length) return { status: 400, body: { errors } };

    const keys = Object.keys(values);
    if (!keys.length) return { status: 400, body: { errors: ['Nothing to update.'] } };

    try {
      db.prepare(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => values[k]), id);
    } catch (err) {
      if (/UNIQUE constraint failed/.test(err.message)) {
        return { status: 409, body: { errors: ['That phone number is already on another client.'] } };
      }
      throw err;
    }
    return { status: 200, body: db.prepare('SELECT * FROM clients WHERE id = ?').get(id) };
  }

  return { status: 405, body: { errors: ['Method not allowed.'] } };
}

/** Handlers for /api/tickets/:id -- matched separately because of the id. */
function ticketByIdRoute(method, id, body) {
  if (method === 'GET') {
    const ticket = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
    if (!ticket) return { status: 404, body: { errors: ['Ticket not found.'] } };
    return { status: 200, body: ticket };
  }

  if (method === 'PATCH' || method === 'PUT') {
    const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
    if (!existing) return { status: 404, body: { errors: ['Ticket not found.'] } };

    const { errors, values } = validateTicket(body, method === 'PATCH');
    if (errors.length) return { status: 400, body: { errors } };

    const keys = Object.keys(values);
    if (!keys.length) return { status: 400, body: { errors: ['Nothing to update.'] } };

    db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => values[k]), id);
    reindexTicket(id);

    return { status: 200, body: db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) };
  }

  return { status: 405, body: { errors: ['Method not allowed.'] } };
}

/* ---------------------------------------------------------------------------
 * HTTP plumbing
 * ------------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error('Request body too large.'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(PUBLIC_DIR, rel);

  // Refuse anything that escapes public/ (e.g. ../../server.js).
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};

    // POST /api/tickets/suggest -- matched before the /:id routes below, which
    // only accept digits, so there is no collision.
    if (url.pathname === '/api/tickets/suggest') {
      if (req.method !== 'POST') return sendJson(res, 405, { errors: ['Method not allowed.'] });
      const result = await suggestRoute(body);
      return sendJson(res, result.status, result.body);
    }

    if (url.pathname === '/api/solution-categories') {
      return sendJson(res, 200, listSolutionCategories());
    }

    // /api/tickets/:id/<action>
    const subMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/(steps|resolve|reopen)$/);
    if (subMatch) {
      const id = Number(subMatch[1]);
      const handlers = {
        steps: ticketStepsRoute,
        resolve: resolveTicketRoute,
        reopen: reopenTicketRoute,
      };
      const result = handlers[subMatch[2]](req.method, id, body);
      return sendJson(res, result.status, result.body);
    }

    // /api/tickets/:id and /api/clients/:id
    const ticketMatch = url.pathname.match(/^\/api\/tickets\/(\d+)$/);
    if (ticketMatch) {
      const result = ticketByIdRoute(req.method, Number(ticketMatch[1]), body);
      return sendJson(res, result.status, result.body);
    }

    const clientMatch = url.pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch) {
      const result = clientByIdRoute(req.method, Number(clientMatch[1]), body);
      return sendJson(res, result.status, result.body);
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return sendJson(res, 404, { errors: ['No such endpoint.'] });

    const result = handler(body, url);
    // Handlers return either a bare payload (200) or {status, body}.
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 200, result);
  } catch (err) {
    console.error(err);
    return sendJson(res, 400, { errors: [err.message || 'Bad request.'] });
  }
});

server.listen(PORT, () => {
  const status = ai.describe();
  console.log(`\n  IT Ticket System running -> http://localhost:${PORT}`);
  console.log(`  Database: ${DB_FILE}`);
  console.log(
    status.configured
      ? `  AI suggestions: ${status.provider} (${status.model})`
      : `  AI suggestions: off (set AI_API_KEY to enable) -- past fixes still shown`
  );
  console.log('  Press Ctrl+C to stop.\n');
});
