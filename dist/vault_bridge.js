import * as fs from 'fs';
import * as path from 'path';
import { OBJECTS_DIR } from './index_store.js';
const MAINNET_URL = 'https://portal.exergynet.org';
const TESTNET_URL = 'https://dt.portal.exergynet.org';
export async function syncToVault(payload, intent) {
    const apiKey = process.env.EXERGYNET_API_KEY;
    if (!apiKey) {
        return { status: 'unconfigured', message: 'EXERGYNET_API_KEY not set — vault sync disabled' };
    }
    const network = (process.env.EXERGYNET_NETWORK ?? 'testnet').toLowerCase();
    const defaultUrl = network === 'mainnet' ? MAINNET_URL : TESTNET_URL;
    const base = (process.env.EXERGYNET_VAULT_URL ?? defaultUrl).replace(/\/$/, '');
    const url = `${base}/api/xlmp/vanguard/ingest`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ payload, intent, network }),
        });
        if (!res.ok) {
            if (res.status === 404) {
                return { status: 'error', message: `Vault endpoint not found (HTTP 404). Verify EXERGYNET_VAULT_URL. [${url}]`, url };
            }
            if (res.status === 401 || res.status === 403) {
                return { status: 'error', message: 'Vault authentication failed (HTTP 401/403). Verify EXERGYNET_API_KEY.', url };
            }
            return { status: 'error', message: `HTTP ${res.status}: ${await res.text()}`, url };
        }
        return { status: 'ok', message: 'synced', url, response: await res.json() };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', message: `Network error: ${msg}`, url };
    }
}
export function readVaultObject(root) {
    const p = path.join(OBJECTS_DIR, `${root}.txt`);
    if (!fs.existsSync(p))
        return null;
    return fs.readFileSync(p, 'utf8');
}
