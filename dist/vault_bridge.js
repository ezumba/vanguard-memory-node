import * as fs from 'fs';
import * as path from 'path';
import { OBJECTS_DIR } from './index_store.js';
const DEFAULT_VAULT_URL = 'https://explorer-api.exergynet.org';
export async function syncToVault(payload, intent) {
    const apiKey = process.env.EXERGYNET_API_KEY;
    if (!apiKey) {
        return { status: 'unconfigured', message: 'EXERGYNET_API_KEY not set — vault sync disabled' };
    }
    const base = (process.env.EXERGYNET_VAULT_URL ?? DEFAULT_VAULT_URL).replace(/\/$/, '');
    const url = `${base}/api/xlmp/ingest`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ payload, intent }),
        });
        if (!res.ok) {
            return { status: 'error', message: `HTTP ${res.status}: ${await res.text()}` };
        }
        return { status: 'ok', message: 'synced', response: await res.json() };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', message: `Network error: ${msg}` };
    }
}
export function readVaultObject(root) {
    const p = path.join(OBJECTS_DIR, `${root}.txt`);
    if (!fs.existsSync(p))
        return null;
    return fs.readFileSync(p, 'utf8');
}
