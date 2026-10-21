import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SOS_STATUSES = ['open', 'acknowledged', 'en_route', 'rescued', 'false_alarm'];
export const TEAM_STATUSES = ['available', 'busy', 'offline'];

export function openDatabase(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS teams (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            contact    TEXT,
            status     TEXT NOT NULL DEFAULT 'available',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sos (
            id            TEXT PRIMARY KEY,
            text          TEXT NOT NULL,
            latitude      REAL,
            longitude     REAL,
            accuracy      REAL,
            created_at    INTEGER NOT NULL,
            received_at   INTEGER NOT NULL,
            is_panic      INTEGER NOT NULL DEFAULT 0,
            is_auto       INTEGER NOT NULL DEFAULT 0,
            fall_severity TEXT,
            fall_impact   REAL,
            sender_id     TEXT NOT NULL,
            hops          INTEGER NOT NULL DEFAULT 0,
            uploaded_by   TEXT,
            priority      INTEGER NOT NULL,
            status        TEXT NOT NULL DEFAULT 'open',
            team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
            note          TEXT,
            updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sos_status ON sos(status, priority, created_at);

        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            sos_id  TEXT NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
            at      INTEGER NOT NULL,
            action  TEXT NOT NULL,
            detail  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_sos ON events(sos_id, at);
    `);
    return db;
}

/**
 * 1 = critical, 2 = high, 3 = normal.
 * Panic presses and critical/severe falls go to the top of the rescue queue.
 */
export function computePriority(msg) {
    if (msg.isPanic) return 1;
    if (msg.fallSeverity === 'critical' || msg.fallSeverity === 'severe') return 1;
    if (msg.isAutoTriggered) return 2;
    return 3;
}

const SOS_SELECT = `
    SELECT s.*, t.name AS team_name
    FROM sos s LEFT JOIN teams t ON t.id = s.team_id
`;

export function toApiSos(row) {
    if (!row) return null;
    return {
        id: row.id,
        text: row.text,
        location: row.latitude == null ? null : {
            latitude: row.latitude,
            longitude: row.longitude,
            accuracy: row.accuracy,
        },
        createdAt: row.created_at,
        receivedAt: row.received_at,
        isPanic: !!row.is_panic,
        isAutoTriggered: !!row.is_auto,
        fallSeverity: row.fall_severity,
        fallImpact: row.fall_impact,
        senderId: row.sender_id,
        hops: row.hops,
        uploadedBy: row.uploaded_by,
        relayed: row.uploaded_by != null && row.uploaded_by !== row.sender_id,
        priority: row.priority,
        status: row.status,
        team: row.team_id == null ? null : { id: row.team_id, name: row.team_name },
        note: row.note,
        updatedAt: row.updated_at,
    };
}

export function createRepository(db) {
    const insertSos = db.prepare(`
        INSERT INTO sos (id, text, latitude, longitude, accuracy, created_at, received_at,
                         is_panic, is_auto, fall_severity, fall_impact, sender_id, hops,
                         uploaded_by, priority, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
        ON CONFLICT(id) DO NOTHING
    `);
    const getSos = db.prepare(`${SOS_SELECT} WHERE s.id = ?`);
    // A phone sends the SOS first and its GPS fix later; fill it in once.
    const addLocation = db.prepare(`
        UPDATE sos SET latitude = ?, longitude = ?, accuracy = ?, updated_at = ?
        WHERE id = ? AND latitude IS NULL
    `);
    const insertEvent = db.prepare('INSERT INTO events (sos_id, at, action, detail) VALUES (?, ?, ?, ?)');

    return {
        /**
         * Inserts new SOS messages. Duplicates (same id relayed by several phones)
         * are ignored, except that a location arriving later fills in a missing one.
         */
        ingest(messages, uploadedBy) {
            const now = Date.now();
            const created = [];
            const updated = [];
            db.exec('BEGIN');
            try {
                for (const m of messages) {
                    const loc = m.location || {};
                    const result = insertSos.run(
                        m.id, m.text, loc.latitude ?? null, loc.longitude ?? null, loc.accuracy ?? null,
                        m.timestamp, now, m.isPanic ? 1 : 0, m.isAutoTriggered ? 1 : 0,
                        m.fallSeverity ?? null, m.fallImpact ?? null, m.senderId, m.hops ?? 0,
                        uploadedBy ?? null, computePriority(m), now,
                    );
                    if (result.changes === 0) {
                        if (m.location && addLocation.run(loc.latitude, loc.longitude, loc.accuracy ?? null, now, m.id).changes > 0) {
                            insertEvent.run(m.id, now, 'location',
                                `GPS fix received (±${Math.round(loc.accuracy ?? 0)} m)`);
                            updated.push(toApiSos(getSos.get(m.id)));
                        }
                        continue;
                    }
                    const via = uploadedBy && uploadedBy !== m.senderId
                        ? `relayed by ${uploadedBy} after ${m.hops} hop(s)`
                        : 'uploaded directly by sender';
                    insertEvent.run(m.id, now, 'received', via);
                    created.push(toApiSos(getSos.get(m.id)));
                }
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
            return { created, updated };
        },

        listSos({ status } = {}) {
            const rows = status
                ? db.prepare(`${SOS_SELECT} WHERE s.status = ? ORDER BY s.priority, s.created_at`).all(status)
                : db.prepare(`${SOS_SELECT} ORDER BY
                      CASE WHEN s.status IN ('rescued','false_alarm') THEN 1 ELSE 0 END,
                      s.priority, s.created_at`).all();
            return rows.map(toApiSos);
        },

        getSos(id) {
            return toApiSos(getSos.get(id));
        },

        /** What a victim's phone is allowed to see about its own requests. */
        publicStatus(ids) {
            if (ids.length === 0) return [];
            const placeholders = ids.map(() => '?').join(',');
            return db.prepare(`
                SELECT s.id, s.status, s.updated_at, t.name AS team_name
                FROM sos s LEFT JOIN teams t ON t.id = s.team_id
                WHERE s.id IN (${placeholders})
            `).all(...ids).map(r => ({ id: r.id, status: r.status, teamName: r.team_name, updatedAt: r.updated_at }));
        },

        updateSos(id, { status, teamId, note }) {
            const current = getSos.get(id);
            if (!current) return null;
            const now = Date.now();
            const changes = [];

            db.exec('BEGIN');
            try {
                if (teamId !== undefined && teamId !== current.team_id) {
                    db.prepare('UPDATE sos SET team_id = ? WHERE id = ?').run(teamId, id);
                    if (teamId != null) {
                        const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId);
                        db.prepare("UPDATE teams SET status = 'busy' WHERE id = ?").run(teamId);
                        changes.push(['assigned', team?.name ?? `team ${teamId}`]);
                    } else {
                        changes.push(['unassigned', null]);
                    }
                    if (current.team_id != null) this._releaseTeamIfIdle(current.team_id);
                }
                if (status && status !== current.status) {
                    db.prepare('UPDATE sos SET status = ? WHERE id = ?').run(status, id);
                    changes.push(['status', `${current.status} → ${status}`]);
                    // A closed case frees its team for the next call.
                    const teamNow = teamId !== undefined ? teamId : current.team_id;
                    if ((status === 'rescued' || status === 'false_alarm') && teamNow != null) {
                        this._releaseTeamIfIdle(teamNow);
                    }
                }
                if (note !== undefined && note !== current.note) {
                    db.prepare('UPDATE sos SET note = ? WHERE id = ?').run(note, id);
                    changes.push(['note', note]);
                }
                if (changes.length) {
                    db.prepare('UPDATE sos SET updated_at = ? WHERE id = ?').run(now, id);
                    for (const [action, detail] of changes) insertEvent.run(id, now, action, detail);
                }
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
            return toApiSos(getSos.get(id));
        },

        _releaseTeamIfIdle(teamId) {
            const active = db.prepare(`
                SELECT COUNT(*) AS n FROM sos
                WHERE team_id = ? AND status NOT IN ('rescued', 'false_alarm')
            `).get(teamId);
            if (active.n === 0) {
                db.prepare("UPDATE teams SET status = 'available' WHERE id = ? AND status = 'busy'").run(teamId);
            }
        },

        events(sosId) {
            return db.prepare('SELECT at, action, detail FROM events WHERE sos_id = ? ORDER BY at, id').all(sosId);
        },

        listTeams() {
            return db.prepare(`
                SELECT t.*, (SELECT COUNT(*) FROM sos s WHERE s.team_id = t.id
                             AND s.status NOT IN ('rescued','false_alarm')) AS active_cases
                FROM teams t ORDER BY t.name
            `).all().map(t => ({
                id: t.id, name: t.name, contact: t.contact, status: t.status, activeCases: t.active_cases,
            }));
        },

        createTeam({ name, contact }) {
            const r = db.prepare('INSERT INTO teams (name, contact, created_at) VALUES (?, ?, ?)')
                .run(name, contact ?? null, Date.now());
            return this.listTeams().find(t => t.id === Number(r.lastInsertRowid));
        },

        updateTeam(id, { name, contact, status }) {
            const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
            if (!t) return null;
            db.prepare('UPDATE teams SET name = ?, contact = ?, status = ? WHERE id = ?')
                .run(name ?? t.name, contact ?? t.contact, status ?? t.status, id);
            return this.listTeams().find(x => x.id === id);
        },

        deleteTeam(id) {
            return db.prepare('DELETE FROM teams WHERE id = ?').run(id).changes > 0;
        },

        stats() {
            const byStatus = Object.fromEntries(SOS_STATUSES.map(s => [s, 0]));
            for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM sos GROUP BY status').all()) {
                byStatus[r.status] = r.n;
            }
            const critical = db.prepare(`
                SELECT COUNT(*) AS n FROM sos WHERE priority = 1 AND status NOT IN ('rescued','false_alarm')
            `).get().n;
            const relayed = db.prepare(`
                SELECT COUNT(*) AS n FROM sos WHERE uploaded_by IS NOT NULL AND uploaded_by != sender_id
            `).get().n;
            const avg = db.prepare(`
                SELECT AVG(e.at - s.received_at) AS ms FROM sos s
                JOIN events e ON e.sos_id = s.id AND e.action = 'status' AND e.detail LIKE '%→ rescued'
            `).get().ms;
            const teams = db.prepare('SELECT status, COUNT(*) AS n FROM teams GROUP BY status').all();
            return {
                byStatus,
                activeCritical: critical,
                relayedThroughMesh: relayed,
                avgTimeToRescueMs: avg == null ? null : Math.round(avg),
                teams: Object.fromEntries(teams.map(t => [t.status, t.n])),
            };
        },
    };
}
