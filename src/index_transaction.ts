/**
 * index_transaction.ts — VMN v1.2.0
 * Serialized write queue for index mutations.
 * Concurrent reads remain safe. Writes are serialized.
 */

import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import { TRANSACTIONS_DIR, atomicWrite, ensureIndexDirs } from './index_store.js';

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Serialize all index write operations through a single queue.
 * Multiple callers may await this concurrently — each gets
 * exclusive access in FIFO order.
 */
export function withIndexWriter<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(() => fn());
  // Advance queue regardless of success/failure
  writeQueue = result.then(() => {}, () => {});
  return result;
}

export interface TransactionRecord {
  transaction_id:   string;
  operation:        'INGEST' | 'DELETE' | 'REBUILD' | 'METADATA_UPDATE' | 'MIGRATE';
  state:            'PREPARED' | 'WRITING' | 'COMMITTED' | 'ROLLED_BACK';
  affected_roots:   string[];
  affected_buckets: string[];
  created_at:       string;
  committed_at:     string | null;
}

export function beginTransaction(
  operation: TransactionRecord['operation'],
  affectedRoots: string[],
  affectedBuckets: string[]
): TransactionRecord {
  ensureIndexDirs();
  const tx: TransactionRecord = {
    transaction_id:   crypto.randomUUID(),
    operation,
    state:            'PREPARED',
    affected_roots:   affectedRoots,
    affected_buckets: affectedBuckets,
    created_at:       new Date().toISOString(),
    committed_at:     null,
  };
  atomicWrite(path.join(TRANSACTIONS_DIR, `${tx.transaction_id}.json`), tx);
  return tx;
}

export function commitTransaction(tx: TransactionRecord): void {
  tx.state        = 'COMMITTED';
  tx.committed_at = new Date().toISOString();
  atomicWrite(path.join(TRANSACTIONS_DIR, `${tx.transaction_id}.json`), tx);
}

export function rollbackTransaction(tx: TransactionRecord): void {
  tx.state = 'ROLLED_BACK';
  atomicWrite(path.join(TRANSACTIONS_DIR, `${tx.transaction_id}.json`), tx);
}

/** On startup: detect and report incomplete transactions */
export function recoverTransactions(): { recovered: number; degraded: string[] } {
  ensureIndexDirs();
  const degraded: string[] = [];
  let recovered = 0;
  try {
    for (const f of fs.readdirSync(TRANSACTIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const txPath = path.join(TRANSACTIONS_DIR, f);
        const tx: TransactionRecord = JSON.parse(fs.readFileSync(txPath, 'utf8'));
        if (tx.state === 'PREPARED' || tx.state === 'WRITING') {
          tx.state = 'ROLLED_BACK';
          atomicWrite(txPath, tx);
          recovered++;
        }
      } catch (e) {
        degraded.push(f);
      }
    }
  } catch (e) { /* TRANSACTIONS_DIR may not exist yet */ }
  return { recovered, degraded };
}
