// Adds a few rescue teams so the dashboard has something to assign on first run.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase, createRepository } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = createRepository(openDatabase(process.env.DB_FILE || join(__dirname, '..', 'data', 'sos.db')));

const teams = [
    { name: 'NDRF Alpha', contact: 'Radio ch. 4' },
    { name: 'Fire & Rescue 2', contact: 'Radio ch. 7' },
    { name: 'Medical Unit 1', contact: 'Radio ch. 9' },
];

const existing = new Set(repo.listTeams().map(t => t.name));
for (const t of teams) {
    if (!existing.has(t.name)) {
        repo.createTeam(t);
        console.log(`added team: ${t.name}`);
    }
}
console.log('teams:', repo.listTeams().map(t => t.name).join(', '));
