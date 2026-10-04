import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentKind,
  NormalizedSession,
  SessionTimeline,
  TimelineEvent,
} from "./schema.js";

export interface SessionMeta {
  agent: AgentKind;
  member?: string;
  title: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  repositories: string[];
  eventCount: number;
  path: string;
}

export interface SessionListItem extends SessionMeta {
  id: string;
}

export interface RepoSummary {
  repo: string;
  sessionCount: number;
}

interface SourceRecord {
  hash: string;
  sessionId: string;
}

interface Manifest {
  version: 1;
  sessions: Record<string, SessionMeta>;
  sources: Record<string, SourceRecord>;
}

const MANIFEST_VERSION: Manifest["version"] = 1;

function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, sessions: {}, sources: {} };
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeJsonAtomic(filename: string, value: unknown): void {
  const temp = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, filename);
}

/**
 * A file-based store for normalized agent traces.
 *
 * Layout:
 *   <dir>/index.json                  manifest: every session's metadata + ingestion source hashes
 *   <dir>/sessions/<agent>/<id>.json  one SessionTimeline per file (session + events)
 *
 * The directory is the product: commit it to git, rsync it, or point an LLM at it.
 */
export class TraceStore {
  readonly dir: string;
  private manifest: Manifest = emptyManifest();
  private manifestMtime = 0;
  private manifestSize = -1;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.sessionsDir(), { recursive: true });
    this.loadManifest();
  }

  private loadManifest(): void {
    const manifestPath = this.manifestPath();
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<Manifest>;
      this.manifest = {
        version: MANIFEST_VERSION,
        sessions: parsed.sessions ?? {},
        sources: parsed.sources ?? {},
      };
      const stat = fs.statSync(manifestPath);
      this.manifestMtime = stat.mtimeMs;
      this.manifestSize = stat.size;
    } else {
      this.manifest = emptyManifest();
      this.saveManifest();
    }
  }

  /** Re-read index.json when another writer (or a file-level edit) changed it. */
  private reloadIfChanged(): void {
    const manifestPath = this.manifestPath();
    try {
      const stat = fs.statSync(manifestPath);
      // size catches same-ms writes where mtime alone would not change
      if (stat.mtimeMs !== this.manifestMtime || stat.size !== this.manifestSize) this.loadManifest();
    } catch {
      if (Object.keys(this.manifest.sessions).length > 0) this.loadManifest(); // manifest deleted
    }
  }

  private manifestPath(): string {
    return path.join(this.dir, "index.json");
  }

  private sessionsDir(): string {
    return path.join(this.dir, "sessions");
  }

  private relativeSessionPath(agent: AgentKind, id: string): string {
    return path.join("sessions", agent, `${safeName(id)}.json`);
  }

  private sessionPath(agent: AgentKind, id: string): string {
    return path.join(this.dir, this.relativeSessionPath(agent, id));
  }

  private saveManifest(): void {
    writeJsonAtomic(this.manifestPath(), this.manifest);
    try {
      const stat = fs.statSync(this.manifestPath());
      this.manifestMtime = stat.mtimeMs;
      this.manifestSize = stat.size;
    } catch { /* best effort */ }
  }

  private readTimeline(meta: SessionMeta): SessionTimeline | null {
    const filename = path.join(this.dir, meta.path);
    if (!fs.existsSync(filename)) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8")) as SessionTimeline;
  }

  private loadExistingEvents(id: string): TimelineEvent[] {
    const meta = this.manifest.sessions[id];
    if (!meta) return [];
    return this.readTimeline(meta)?.events ?? [];
  }

  private writeTimeline(timeline: SessionTimeline, member?: string): void {
    const { session } = timeline;
    const relativePath = this.relativeSessionPath(session.agent, session.id);
    const filename = path.join(this.dir, relativePath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    writeJsonAtomic(filename, timeline);
    this.manifest.sessions[session.id] = {
      agent: session.agent,
      member: member ?? this.manifest.sessions[session.id]?.member,
      title: session.title,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      repositories: session.repositories,
      eventCount: timeline.events.length,
      path: relativePath,
    };
    this.saveManifest();
  }

  upsertSession(session: NormalizedSession, member?: string): void {
    this.reloadIfChanged();
    this.writeTimeline({ session, events: this.loadExistingEvents(session.id) }, member);
  }

  /** Store a complete timeline (e.g. shipped by a hook at session end). */
  upsertTimeline(timeline: SessionTimeline, member?: string): void {
    this.reloadIfChanged();
    this.writeTimeline(timeline, member);
  }

  upsertEvents(events: TimelineEvent[]): void {
    this.reloadIfChanged();
    const bySession = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      const list = bySession.get(event.sessionId) ?? [];
      list.push(event);
      bySession.set(event.sessionId, list);
    }
    for (const [sessionId, additions] of bySession) {
      const meta = this.manifest.sessions[sessionId];
      if (!meta) continue;
      const timeline = this.readTimeline(meta) ?? {
        session: {
          schemaVersion: 1,
          agent: meta.agent,
          id: sessionId,
          title: meta.title,
          prompt: null,
          status: meta.status,
          statusDetail: null,
          origin: null,
          startedAt: meta.startedAt,
          updatedAt: meta.updatedAt,
          acusConsumed: 0,
          url: null,
          repositories: meta.repositories,
          pullRequests: [],
          tags: [],
          raw: {},
        } satisfies NormalizedSession,
        events: [],
      };
      const merged = new Map(timeline.events.map((event) => [event.id, event]));
      for (const event of additions) merged.set(event.id, event);
      this.writeTimeline({
        session: timeline.session,
        events: [...merged.values()].sort(
          (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
        ),
      });
    }
  }

  replaceEvents(sessionId: string, events: TimelineEvent[]): void {
    this.reloadIfChanged();
    const meta = this.manifest.sessions[sessionId];
    if (!meta) return;
    const timeline = this.readTimeline(meta);
    if (!timeline) return;
    this.writeTimeline({ session: timeline.session, events });
  }

  /** Returns the stored metadata for a session, for incremental-sync checks. */
  getMeta(id: string): SessionMeta | null {
    this.reloadIfChanged();
    return this.manifest.sessions[id] ?? null;
  }

  getTimeline(id: string): SessionTimeline | null {
    this.reloadIfChanged();
    const meta = this.manifest.sessions[id];
    return meta ? this.readTimeline(meta) : null;
  }

  listSessions(options: { agent?: AgentKind; member?: string; repo?: string; query?: string } = {}): SessionListItem[] {
    this.reloadIfChanged();
    const query = options.query?.toLowerCase();
    return Object.entries(this.manifest.sessions)
      .filter(([, meta]) => {
        if (options.agent && meta.agent !== options.agent) return false;
        if (options.member && meta.member !== options.member) return false;
        if (options.repo && !meta.repositories.includes(options.repo)) return false;
        if (query && !meta.title.toLowerCase().includes(query)) return false;
        return true;
      })
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  listRepos(agent?: AgentKind): RepoSummary[] {
    this.reloadIfChanged();
    const counts = new Map<string, number>();
    for (const meta of Object.values(this.manifest.sessions)) {
      if (agent && meta.agent !== agent) continue;
      for (const repo of meta.repositories) counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([repo, sessionCount]) => ({ repo, sessionCount }))
      .sort((a, b) => b.sessionCount - a.sessionCount || a.repo.localeCompare(b.repo));
  }

  countSessions(agent?: AgentKind): number {
    this.reloadIfChanged();
    return Object.values(this.manifest.sessions)
      .filter((meta) => !agent || meta.agent === agent)
      .length;
  }

  /** Cheap change detection for ingestion sources (e.g. a Codex rollout file). */
  static sourceHash(filename: string): string {
    const stat = fs.statSync(filename);
    return createHash("sha256")
      .update(`${filename}${stat.size}${stat.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
  }

  /** Session id previously ingested from this unchanged source, if any. */
  lookupSource(filename: string): string | null {
    this.reloadIfChanged();
    const record = this.manifest.sources[filename];
    return record && record.hash === TraceStore.sourceHash(filename) ? record.sessionId : null;
  }

  recordSource(filename: string, sessionId: string): void {
    this.reloadIfChanged();
    this.manifest.sources[filename] = { hash: TraceStore.sourceHash(filename), sessionId };
    this.saveManifest();
  }
}
