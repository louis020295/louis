import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import type { DataProvenance } from '../src/types/market.ts';

function makeLiveProvenance(): DataProvenance {
  return {
    source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
    fetchedAt: new Date().toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
}

function cleanupDbFiles(dbPath: string): void {
  for (const suffix of [
    '',
    '-wal',
    '-shm',
    '-journal',
    '.backup.sqlite',
    '.backup.sqlite.tmp',
    '.ledger-checkpoint.json',
    '.ledger-checkpoint.json.tmp',
    '.window-checkpoint.json',
  ]) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

test('Paper Trading Ledger survives stale .backup.sqlite rollback, WAL loss, and runtime SQLite recovery', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ledger-durability-'));
  const dbPath = path.join(tmpDir, 'radar.sqlite');

  try {
    // 1. Seed initial ledger entry and take a verified .backup.sqlite snapshot
    const db1 = new RadarDatabase(dbPath);
    const e1 = db1.addPaperLedgerEntry({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      strategyTrack: 'FORMAL_SMC_MARKET',
      entryPrice: 95000,
      invalidationPrice: 93500,
      targetPrice: 98000,
      ruleVersion: SMC_RULE_VERSION,
      evidences: ['Initial seed trade before backup'],
      notes: 'Trade #1',
      provenance: makeLiveProvenance(),
    });
    assert.equal(e1.id, 1);

    const backupHealth = db1.performDatabaseHealthCheck('binance_usdm', {
      runBackup: true,
    });
    assert.equal(backupHealth.backupFileVerified, true);

    // 2. After the 6h backup window, add 2 more trades and close Trade #1 (WITHOUT running runBackup: true)
    const closedE1 = db1.closePaperLedgerEntry(e1.id, 96500, 'Closed win after backup');
    assert.ok(closedE1);
    assert.equal(closedE1.status, 'CLOSED_MANUAL');

    const e2 = db1.addPaperLedgerEntry({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '1h',
      side: 'SHORT',
      category: '空頭候選',
      actionState: 'SHORT CANDIDATE',
      strategyTrack: 'SMC_PULLBACK_LIMIT',
      fillStatus: 'WAITING_LIMIT',
      ttlMinutes: 240,
      entryPrice: 3400,
      invalidationPrice: 3500,
      targetPrice: 3200,
      ruleVersion: SMC_RULE_VERSION,
      evidences: ['Pullback limit trade after stale backup'],
      notes: 'Trade #2',
      provenance: makeLiveProvenance(),
    });
    assert.equal(e2.id, 2);

    const e3 = db1.addPaperLedgerEntry({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '準備觀察',
      actionState: 'WATCH',
      strategyTrack: 'EARLY_IGNITION',
      entryPrice: 210,
      invalidationPrice: 202,
      targetPrice: 226,
      ruleVersion: SMC_RULE_VERSION,
      evidences: ['Early ignition trade after stale backup'],
      notes: 'Trade #3',
      provenance: makeLiveProvenance(),
    });
    assert.equal(e3.id, 3);

    // Verify atomic checkpoint file exists with all 3 rows immediately
    const checkpointPath = `${dbPath}.ledger-checkpoint.json`;
    assert.equal(fs.existsSync(checkpointPath), true);
    const checkpointJson = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {
      entries: Array<{ id: number; status: string }>;
    };
    assert.equal(checkpointJson.entries.length, 3);
    db1.close();

    // 3. Simulate corruption triggering rollback to the STALE .backup.sqlite (which only had Trade #1 as OPEN!)
    fs.writeFileSync(dbPath, Buffer.from('CORRUPT_HEADER_FORCE_BACKUP_ROLLBACK'));
    for (const sidecar of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(`${dbPath}${sidecar}`)) {
        fs.unlinkSync(`${dbPath}${sidecar}`);
      }
    }

    const db2 = new RadarDatabase(dbPath);
    const recoveredEntries = db2.listPaperLedgerEntries(50);
    assert.equal(
      recoveredEntries.length,
      3,
      'All 3 paper ledger trades must survive stale .backup.sqlite rollback'
    );

    const byId = new Map(recoveredEntries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(1)?.symbol, 'BTCUSDT');
    assert.equal(
      byId.get(1)?.status,
      'CLOSED_MANUAL',
      'Trade #1 closed state must NOT roll back to OPEN from stale backup'
    );
    assert.equal(byId.get(1)?.exitPrice, 96500);
    assert.equal(byId.get(2)?.symbol, 'ETHUSDT');
    assert.equal(byId.get(2)?.fillStatus, 'WAITING_LIMIT');
    assert.equal(byId.get(3)?.symbol, 'SOLUSDT');

    // Next inserted trade must get monotonic ID = 4 (no ID collision)
    const e4 = db2.addPaperLedgerEntry({
      symbol: 'BNBUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      entryPrice: 620,
      invalidationPrice: 600,
      targetPrice: 660,
      ruleVersion: SMC_RULE_VERSION,
      evidences: ['Post-recovery new entry'],
      notes: 'Trade #4',
      provenance: makeLiveProvenance(),
    });
    assert.equal(e4.id, 4);

    // 4. Verify runtime SQLite recovery preserves all 4 entries even if main file is overwritten
    fs.writeFileSync(dbPath, Buffer.from('RUNTIME_CORRUPTION_HEADER'));
    const runtimeOk = db2.recoverFromRuntimeSqliteError(
      Object.assign(new Error('file is not a database'), {
        code: 'ERR_SQLITE_ERROR',
      }),
      'binance_usdm'
    );
    assert.equal(runtimeOk, true);
    const afterRuntimeEntries = db2.listPaperLedgerEntries(50);
    assert.equal(afterRuntimeEntries.length, 4);

    // 5. Verify anti-clobber guard: deleting rows directly in DB does not wipe non-empty checkpoint on close/save
    db2.getRawDb().exec('DELETE FROM paper_trading_ledger;');
    db2.savePaperLedgerCheckpointToDisk();
    db2.close();

    const db3 = new RadarDatabase(dbPath);
    assert.equal(
      db3.listPaperLedgerEntries(50).length,
      4,
      'Non-empty checkpoint must protect against accidental empty clobber'
    );
    db3.close();
  } finally {
    cleanupDbFiles(dbPath);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
