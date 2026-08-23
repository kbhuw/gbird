import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  NormalizedSession,
  SessionAnalysis,
  SessionTimeline,
  StoredSessionAnalysis,
  TimelineEvent,
} from "./schema.js";

export interface SessionListItem extends NormalizedSession {
  eventCount: number;
  failureCount: number;
}

export interface RepoSummary {
  repo: string;
  sessionCount: number;
}

export class TimelineStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL DEFAULT 'devin',
        title TEXT NOT NULL,
        prompt TEXT,
        status TEXT NOT NULL,
        status_detail TEXT,
        origin TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acus_consumed REAL NOT NULL DEFAULT 0,
        url TEXT,
        session_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_repos (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        PRIMARY KEY (session_id, repo)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        repo TEXT,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT,
        commit_sha TEXT,
        path TEXT,
        url TEXT,
        event_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_analyses (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_hash TEXT NOT NULL,
        analyzer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        analysis_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_time
        ON events(session_id, occurred_at, id);
      CREATE INDEX IF NOT EXISTS events_repo_time
        ON events(repo, occurred_at);
      CREATE INDEX IF NOT EXISTS session_repos_repo
        ON session_repos(repo, session_id);
    `);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "agent")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'devin'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_agent_time ON sessions(agent, started_at DESC)");
  }

  upsertSession(session: NormalizedSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, agent, title, prompt, status, status_detail, origin, started_at,
        updated_at, acus_consumed, url, session_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent,
        title = excluded.title,
        prompt = excluded.prompt,
        status = excluded.status,
        status_detail = excluded.status_detail,
        origin = excluded.origin,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        acus_consumed = excluded.acus_consumed,
        url = excluded.url,
        session_json = excluded.session_json
    `).run(
      session.id,
      session.agent,
      session.title,
      session.prompt,
      session.status,
      session.statusDetail,
      session.origin,
      session.startedAt,
      session.updatedAt,
      session.acusConsumed,
      session.url,
      JSON.stringify(session),
    );

    this.db.prepare("DELETE FROM session_repos WHERE session_id = ?").run(session.id);
    const addRepo = this.db.prepare("INSERT OR IGNORE INTO session_repos (session_id, repo) VALUES (?, ?)");
    for (const repo of session.repositories) addRepo.run(session.id, repo);
  }

  upsertEvents(events: TimelineEvent[]): void {
    const statement = this.db.prepare(`
      INSERT INTO events (
        id, session_id, repo, occurred_at, source, type, title, status,
        commit_sha, path, url, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo = excluded.repo,
        occurred_at = excluded.occurred_at,
        source = excluded.source,
        type = excluded.type,
        title = excluded.title,
        status = excluded.status,
        commit_sha = excluded.commit_sha,
        path = excluded.path,
        url = excluded.url,
        event_json = excluded.event_json
    `);

    for (const event of events) {
      statement.run(
        event.id,
        event.sessionId,
        event.repo,
        event.occurredAt,
        event.source,
        event.type,
        event.title,
        event.status,
        event.commitSha,
        event.path,
        event.url,
        JSON.stringify(event),
      );
    }
  }

  replaceEvents(sessionId: string, events: TimelineEvent[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
      this.upsertEvents(events);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countSessions(agent?: AgentKind): number {
    const row = agent
      ? this.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE agent = ?").get(agent) as { count: number }
      : this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    return Number(row.count);
  }

  listRepos(agent?: AgentKind): RepoSummary[] {
    const where = agent ? "WHERE s.agent = ?" : "";
    const rows = this.db.prepare(`
      SELECT sr.repo, COUNT(*) AS session_count
      FROM session_repos sr
      JOIN sessions s ON s.id = sr.session_id
      ${where}
      GROUP BY sr.repo
      ORDER BY session_count DESC, sr.repo ASC
    `).all(...(agent ? [agent] : [])) as Array<{ repo: string; session_count: number }>;
    return rows.map((row) => ({ repo: row.repo, sessionCount: Number(row.session_count) }));
  }

  listSessions(options: { agent?: AgentKind; repo?: string; query?: string } = {}): SessionListItem[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (options.agent) {
      clauses.push("s.agent = ?");
      parameters.push(options.agent);
    }
    if (options.repo) {
      clauses.push("EXISTS (SELECT 1 FROM session_repos sr WHERE sr.session_id = s.id AND sr.repo = ?)");
      parameters.push(options.repo);
    }
    if (options.query) {
      clauses.push("(LOWER(s.title) LIKE ? OR LOWER(COALESCE(s.prompt, '')) LIKE ?)");
      const query = `%${options.query.toLowerCase()}%`;
      parameters.push(query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT
        s.session_json,
        s.agent,
        COUNT(e.id) AS event_count,
        SUM(CASE WHEN e.status IN ('failure', 'failed', 'cancelled', 'timed_out') THEN 1 ELSE 0 END) AS failure_count
      FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY s.started_at DESC, s.id DESC
    `).all(...parameters) as Array<{ session_json: string; agent: AgentKind; event_count: number; failure_count: number }>;

    return rows.map((row) => ({
      ...(JSON.parse(row.session_json) as NormalizedSession),
      agent: row.agent,
      eventCount: Number(row.event_count),
      failureCount: Number(row.failure_count),
    }));
  }

  getTimeline(id: string): SessionTimeline | null {
    const row = this.db.prepare("SELECT session_json, agent FROM sessions WHERE id = ?").get(id) as
      | { session_json: string; agent: AgentKind }
      | undefined;
    if (!row) return null;
    const eventRows = this.db.prepare(`
      SELECT event_json FROM events
      WHERE session_id = ?
      ORDER BY occurred_at ASC, id ASC
    `).all(id) as Array<{ event_json: string }>;
    return {
      session: { ...(JSON.parse(row.session_json) as NormalizedSession), agent: row.agent },
      events: eventRows.map((event) => JSON.parse(event.event_json) as TimelineEvent),
    };
  }

  upsertAnalysis(record: StoredSessionAnalysis): void {
    this.db.prepare(`
      INSERT INTO session_analyses (
        session_id, input_hash, analyzer, created_at, analysis_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        input_hash = excluded.input_hash,
        analyzer = excluded.analyzer,
        created_at = excluded.created_at,
        analysis_json = excluded.analysis_json
    `).run(
      record.sessionId,
      record.inputHash,
      record.analyzer,
      record.createdAt,
      JSON.stringify(record.analysis),
    );
  }

  getAnalysis(sessionId: string): StoredSessionAnalysis | null {
    const row = this.db.prepare(`
      SELECT input_hash, analyzer, created_at, analysis_json
      FROM session_analyses
      WHERE session_id = ?
    `).get(sessionId) as {
      input_hash: string;
      analyzer: string;
      created_at: string;
      analysis_json: string;
    } | undefined;
    if (!row) return null;
    return {
      sessionId,
      inputHash: row.input_hash,
      analyzer: row.analyzer,
      createdAt: row.created_at,
      analysis: JSON.parse(row.analysis_json) as SessionAnalysis,
    };
  }

  close(): void {
    this.db.close();
  }
}
