#!/usr/bin/env node
/**
 * VMN 2.0.2 — Protocol surface gate tests
 * Tests MCP resources (memory://stats, memory://all) and prompts (vmn-store, vmn-find)
 * at the wire level via stdio JSON-RPC.
 */
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '../dist/index.js');

let passed = 0, failed = 0;
function check(id, label, ok) {
  if (ok) { console.log(`PASS  ${String(id).padStart(2)}  ${label}`); passed++; }
  else     { console.error(`FAIL  ${String(id).padStart(2)}  ${label}`); failed++; }
}

async function run() {
  const server = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VMN_VAULT_PATH: '/tmp/vmn-proto-test-vault' }
  });

  const stderrLines = [];
  server.stderr.on('data', d => stderrLines.push(d.toString()));

  // ── Promise-based response collector ─────────────────────────────────────────
  let buf = '';
  const pending = new Map();

  server.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* non-JSON line, ignore */ }
    }
  });

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method} (id=${id}) — no response in 2s`));
      }, 2000);
      pending.set(id, {
        resolve: msg => { clearTimeout(t); resolve(msg); }
      });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method) {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  // ── initialize ────────────────────────────────────────────────────────────────
  const initResp = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'protocol-gate', version: '2.0.2' }
  });
  check(1, 'initialize: response received',   !!initResp?.result);
  check(2, 'initialize: no error',             !initResp?.error);
  check(3, 'initialize: resources capability', !!initResp?.result?.capabilities?.resources);
  check(4, 'initialize: prompts capability',   !!initResp?.result?.capabilities?.prompts);
  check(5, 'initialize: tools capability',     !!initResp?.result?.capabilities?.tools);

  notify('notifications/initialized');

  // ── resources/list ────────────────────────────────────────────────────────────
  const resListResp = await request(2, 'resources/list', {});
  const resList = resListResp?.result?.resources ?? [];
  const statsRes = resList.find(r => r.uri === 'memory://stats');
  const allRes   = resList.find(r => r.uri === 'memory://all');
  check(6,  'resources/list: memory://stats present',       !!statsRes);
  check(7,  'resources/list: memory://all present',         !!allRes);
  check(8,  'resources/list: memory://stats has name',      typeof statsRes?.name === 'string');
  check(9,  'resources/list: memory://all has name',        typeof allRes?.name === 'string');

  // ── resources/read memory://stats ─────────────────────────────────────────────
  const statsReadResp = await request(3, 'resources/read', { uri: 'memory://stats' });
  const statsContent  = statsReadResp?.result?.contents?.[0];
  check(10, 'resources/read stats: no error',                !statsReadResp?.error);
  check(11, 'resources/read stats: contents present',        !!statsContent);
  check(12, 'resources/read stats: mimeType=application/json', statsContent?.mimeType === 'application/json');
  const statsParsed = (() => { try { return JSON.parse(statsContent?.text ?? ''); } catch { return null; } })();
  check(13, 'resources/read stats: valid JSON body',         statsParsed !== null);

  // ── resources/read memory://all ───────────────────────────────────────────────
  const allReadResp = await request(4, 'resources/read', { uri: 'memory://all' });
  const allContent  = allReadResp?.result?.contents?.[0];
  check(14, 'resources/read all: no error',                  !allReadResp?.error);
  check(15, 'resources/read all: contents present',          !!allContent);
  check(16, 'resources/read all: mimeType=application/json', allContent?.mimeType === 'application/json');
  const allParsed = (() => { try { return JSON.parse(allContent?.text ?? ''); } catch { return null; } })();
  check(17, 'resources/read all: valid JSON body',           allParsed !== null);
  check(18, 'resources/read all: has total field (number)',  typeof allParsed?.total === 'number');
  check(19, 'resources/read all: has entries array',         Array.isArray(allParsed?.entries));

  // ── prompts/list ──────────────────────────────────────────────────────────────
  const promptListResp = await request(5, 'prompts/list', {});
  const promptList = promptListResp?.result?.prompts ?? [];
  const storeP = promptList.find(p => p.name === 'vmn-store');
  const findP  = promptList.find(p => p.name === 'vmn-find');
  check(20, 'prompts/list: vmn-store present',               !!storeP);
  check(21, 'prompts/list: vmn-find present',                !!findP);
  check(22, 'prompts/list: vmn-store has description',       typeof storeP?.description === 'string' && storeP.description.length > 0);
  check(23, 'prompts/list: vmn-find has description',        typeof findP?.description === 'string'  && findP.description.length > 0);
  check(24, 'prompts/list: vmn-store has arguments schema',  Array.isArray(storeP?.arguments));
  check(25, 'prompts/list: vmn-find has arguments schema',   Array.isArray(findP?.arguments));

  // ── prompts/get vmn-store ─────────────────────────────────────────────────────
  const storeResp = await request(6, 'prompts/get', {
    name: 'vmn-store',
    arguments: { text: 'hello world', title: 'gate-test-title' }
  });
  const storeMsg = storeResp?.result?.messages?.[0];
  check(26, 'prompts/get vmn-store: no error',               !storeResp?.error);
  check(27, 'prompts/get vmn-store: message returned',       !!storeMsg);
  check(28, 'prompts/get vmn-store: role=user',              storeMsg?.role === 'user');
  check(29, 'prompts/get vmn-store: text has vmn_ingest',    storeMsg?.content?.text?.includes('vmn_ingest'));
  check(30, 'prompts/get vmn-store: title arg interpolated', storeMsg?.content?.text?.includes('gate-test-title'));

  // ── prompts/get vmn-find ──────────────────────────────────────────────────────
  const findResp = await request(7, 'prompts/get', {
    name: 'vmn-find',
    arguments: { query: 'gate-test-query' }
  });
  const findMsg = findResp?.result?.messages?.[0];
  check(31, 'prompts/get vmn-find: no error',                !findResp?.error);
  check(32, 'prompts/get vmn-find: message returned',        !!findMsg);
  check(33, 'prompts/get vmn-find: role=user',               findMsg?.role === 'user');
  check(34, 'prompts/get vmn-find: text has vmn_search',     findMsg?.content?.text?.includes('vmn_search'));
  check(35, 'prompts/get vmn-find: query arg interpolated',  findMsg?.content?.text?.includes('gate-test-query'));

  // ── tools count (regression guard) ────────────────────────────────────────────
  const toolsListResp = await request(8, 'tools/list', {});
  const tools = toolsListResp?.result?.tools ?? [];
  check(36, 'tools/list: all 11 tools present',              tools.length === 11);
  const expectedTools = [
    'vmn_ingest','vmn_recall','vmn_list','vmn_search','vmn_inspect',
    'vmn_delete','vmn_stats','vmn_index_status','vmn_rebuild_index',
    'vmn_sync_vault','vmn_ingest_file'
  ];
  for (const t of expectedTools) {
    check(37, `tools/list: ${t} present`, tools.some(x => x.name === t));
  }

  // ── stderr cleanliness ─────────────────────────────────────────────────────────
  server.kill();
  const stderrText = stderrLines.join('');
  const errorLines = stderrText.split('\n').filter(l => /uncaught|unhandled|exception/i.test(l));
  check(37 + expectedTools.length, 'stderr: no uncaught/unhandled errors', errorLines.length === 0);

  console.log(`\nProtocol surface gate: ${passed}/${passed + failed} pass`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
