-- ============================================================
--  IT Ticket Management System - database schema
--  Applied automatically by server.js on startup (idempotent).
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- clients
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name  TEXT    NOT NULL CHECK (length(trim(first_name)) > 0),
    last_name   TEXT    NOT NULL CHECK (length(trim(last_name))  > 0),
    phone_1     TEXT    NOT NULL CHECK (length(trim(phone_1))    > 0),
    phone_2     TEXT,
    email       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One client per phone number. The index is built over a normalised form of
-- phone_1 with separators stripped, so "555-0100", "555 0100", "(555) 0100"
-- and "+5550100" all collide instead of sneaking in as separate clients.
-- server.js mirrors this expression in PHONE_KEY -- keep the two in step.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_phone_1 ON clients (
    replace(replace(replace(replace(replace(replace(
        phone_1, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')
);

-- ------------------------------------------------------------
-- tickets
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    title              TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    description        TEXT,
    steps_to_reproduce TEXT,
    brand              TEXT,
    model              TEXT,
    client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    price              REAL,   -- total charged for the REPAIR, not the device's value
    password           TEXT,   -- device / account password left by the client
    priority           TEXT    NOT NULL DEFAULT 'Low'
                               CHECK (priority IN ('Low', 'Medium', 'High', 'Critical')),
    status             TEXT    NOT NULL DEFAULT 'Open'
                               CHECK (status IN ('Open', 'In Progress', 'Resolved', 'Closed')),
    -- What actually fixed it. Captured when the ticket is resolved; kept when
    -- it is reopened so the history is never lost, only edited on re-resolve.
    solution_summary   TEXT,
    solution_category  TEXT,
    resolved_at        TEXT,
    resolved_by        INTEGER,  -- reserved: this app has no user accounts yet
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_client   ON tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);

-- ------------------------------------------------------------
-- ticket_steps -- the diagnostic log a tech fills in while working.
-- This is the richest signal for matching future tickets: the reasoning,
-- not just the one-line answer.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    step_text  TEXT    NOT NULL CHECK (length(trim(step_text)) > 0),
    created_by INTEGER,   -- reserved: this app has no user accounts yet
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_steps_ticket ON ticket_steps(ticket_id, id);

-- ------------------------------------------------------------
-- ticket_search -- full-text index used to find similar past tickets.
-- MySQL would use FULLTEXT + MATCH...AGAINST; SQLite's equivalent is FTS5
-- with bm25() ranking. One row per ticket holding its title, description,
-- steps to reproduce, solution and the whole diagnostic step log, rebuilt
-- by server.js whenever any of those change (see reindexTicket).
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS ticket_search USING fts5(
    ticket_id UNINDEXED,
    title,
    body,
    solution
);

-- Keep updated_at fresh on every UPDATE (unless the update sets it explicitly).
CREATE TRIGGER IF NOT EXISTS trg_tickets_updated_at
AFTER UPDATE ON tickets
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE tickets SET updated_at = datetime('now') WHERE id = NEW.id;
END;
