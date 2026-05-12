// Portions derived from Hermes Agent (MIT) - NousResearch
// https://github.com/NousResearch/hermes-agent
//
// Per-workspace SQLite store with FTS5 full-text search across session messages.
// DB lives at <workspaceDir>/state.db — one database per agent workspace.

import fs from "node:fs";
import path from "node:path";

// Lazy import to avoid loading the native module at startup on paths that
// never open a database. The dynamic import resolves to CJS require() via
// the hoisted node_modules layout.
let _Database: typeof import("better-sqlite3") | undefined;

function getDatabase(): typeof import("better-sqlite3") {
  if (!_Database) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Database = require("better-sqlite3") as typeof import("better-sqlite3");
  }
  return _Database;
}

const SCHEMA_VERSION = 1;

// WAL mode improves concurrent read/write throughput.
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -8000;
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id   TEXT PRIMARY KEY,
  model TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL DEFAULT '',
  tool_name  TEXT,
  ts         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

-- Default unicode61 FTS5 table (Latin/English)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  tool_name,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, tool_name)
    VALUES (new.id, new.content, coalesce(new.tool_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name)
    VALUES ('delete', old.id, old.content, coalesce(old.tool_name, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name)
    VALUES ('delete', old.id, old.content, coalesce(old.tool_name, ''));
  INSERT INTO messages_fts(rowid, content, tool_name)
    VALUES (new.id, new.content, coalesce(new.tool_name, ''));
END;

-- Trigram FTS5 table for CJK and substring search.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
  content,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts_trigram(rowid, content)
    VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
    VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts_trigram(rowid, content)
    VALUES (new.id, new.content);
END;
`;

export type SearchResult = {
  id: number;
  sessionId: string;
  role: string;
  /** FTS5 snippet with >>> / <<< markers around matching terms. */
  snippet: string;
  content: string;
  ts: number;
  toolName: string | null;
  model: string | null;
  sessionStartedAt: number;
};

export type InsertMessageParams = {
  sessionId: string;
  role: string;
  content: string;
  toolName?: string;
};

export type SearchOptions = {
  sessionId?: string;
  roleFilter?: string[];
  limit?: number;
  offset?: number;
};

// CJK Unicode ranges (matches Hermes _is_cjk_codepoint)
const CJK_RANGES: [number, number][] = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // CJK Extension A
  [0x20000, 0x2a6df], // CJK Extension B
  [0x3000, 0x303f], // CJK Symbols
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables
];

function isCjkCodepoint(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function countCjk(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (isCjkCodepoint(ch.codePointAt(0) ?? 0)) count++;
  }
  return count;
}

/**
 * Sanitize user input for safe use in FTS5 MATCH queries.
 *
 * Ported from hermes_state.py SessionDB._sanitize_fts5_query().
 * Preserves quoted phrases, strips unbalanced special chars, wraps
 * hyphenated/dotted terms in quotes so FTS5 matches them as phrases.
 */
export function sanitizeFts5Query(query: string): string {
  // Step 1: protect balanced quoted phrases with placeholders
  const quotedParts: string[] = [];
  let sanitized = query.replace(/"[^"]*"/g, (m) => {
    quotedParts.push(m);
    return `\x00Q${quotedParts.length - 1}\x00`;
  });

  // Step 2: strip unmatched FTS5-special characters
  sanitized = sanitized.replace(/[+{}()"^]/g, " ");

  // Step 3: collapse repeated * and remove leading *
  sanitized = sanitized.replace(/\*+/g, "*").replace(/(^|\s)\*/g, "$1");

  // Step 4: remove dangling boolean operators at boundaries
  sanitized = sanitized
    .trim()
    .replace(/^(AND|OR|NOT)\b\s*/i, "")
    .trim()
    .replace(/\s+(AND|OR|NOT)\s*$/i, "")
    .trim();

  // Step 5: wrap dotted/hyphenated/underscored terms in quotes so FTS5
  // doesn't split them (e.g. "chat-send" → "\"chat-send\"")
  sanitized = sanitized.replace(/\b(\w+(?:[._-]\w+)+)\b/g, '"$1"');

  // Step 6: restore preserved quoted phrases
  for (let i = 0; i < quotedParts.length; i++) {
    sanitized = sanitized.replace(`\x00Q${i}\x00`, quotedParts[i]!);
  }

  return sanitized.trim();
}

export class FtsStore {
  private readonly db: import("better-sqlite3").Database;

  private constructor(dbPath: string) {
    const Database = getDatabase();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this._initialize();
  }

  static open(dbPath: string): FtsStore {
    return new FtsStore(dbPath);
  }

  private _initialize(): void {
    this.db.exec(PRAGMAS);
    this.db.exec(SCHEMA_SQL);
    this._migrateSchemaVersion();
  }

  private _migrateSchemaVersion(): void {
    const row = this.db
      .prepare("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1")
      .get() as { version: number } | undefined;

    if (!row) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }
    // Future migrations go here with if (row.version < N) { ... }
  }

  ensureSession(sessionId: string, model?: string): void {
    this.db
      .prepare("INSERT INTO sessions (id, model) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
      .run(sessionId, model ?? null);
  }

  insertMessage(params: InsertMessageParams): void {
    this.db
      .prepare("INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, ?, ?, ?)")
      .run(params.sessionId, params.role, params.content, params.toolName ?? null);
  }

  /**
   * Full-text search across session messages using FTS5.
   *
   * Automatically routes CJK-heavy queries to the trigram table,
   * mirroring Hermes SessionDB.search_messages().
   *
   * FTS5 query syntax:
   *   - Keywords:  "docker deployment"
   *   - Phrases:   '"exact phrase"'
   *   - Boolean:   "docker OR kubernetes", "python NOT java"
   *   - Prefix:    "deploy*"
   */
  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const { sessionId, roleFilter, limit = 20, offset = 0 } = opts;

    if (!query.trim()) return [];

    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const useTrigram = countCjk(sanitized) >= 3;
    const ftsTable = useTrigram ? "messages_fts_trigram" : "messages_fts";

    const whereClauses: string[] = [`${ftsTable} MATCH ?`];
    const params: unknown[] = [sanitized];

    if (sessionId) {
      whereClauses.push("m.session_id = ?");
      params.push(sessionId);
    }

    if (roleFilter?.length) {
      whereClauses.push(`m.role IN (${roleFilter.map(() => "?").join(", ")})`);
      params.push(...roleFilter);
    }

    const whereSQL = whereClauses.join(" AND ");
    params.push(limit, offset);

    const snippetCol = useTrigram
      ? `substr(m.content, 1, 200)` // trigram table lacks snippet() support
      : `snippet(${ftsTable}, 0, '>>>', '<<<', '...', 40)`;

    const sql = `
      SELECT
        m.id,
        m.session_id AS sessionId,
        m.role,
        ${snippetCol} AS snippet,
        m.content,
        m.ts,
        m.tool_name AS toolName,
        s.model,
        s.started_at AS sessionStartedAt
      FROM ${ftsTable}
      JOIN messages  m ON m.id = ${ftsTable}.rowid
      JOIN sessions  s ON s.id = m.session_id
      WHERE ${whereSQL}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params) as SearchResult[];
  }

  close(): void {
    this.db.close();
  }
}
