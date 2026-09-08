import { lstat, opendir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';

type State = 'complete' | 'missing' | 'partial' | 'unsafe' | 'unavailable';
interface Usage {
  state: State;
  logicalBytes: number;
  regularFiles: number;
  skippedEntries: number;
}
export interface StorageReport {
  readOnly: true;
  approximate: true;
  totalLogicalBytes: number;
  totalIsLowerBound: boolean;
  entriesExamined: number;
  journal: Usage;
  attachments: Usage;
  logs: Usage;
}

/** Metadata only, fixed scopes; the cooperative budget cannot interrupt one OS call. */
export async function inspectStorage(dataDir: string, configPath: string, options: { maxEntries?: number; budgetMs?: number } = {}): Promise<StorageReport> {
  const maxEntries = options.maxEntries ?? 2000, budgetMs = options.budgetMs ?? 250;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000 || !Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 250) throw new Error('Invalid storage inspection limits.');
  const deadline = performance.now() + budgetMs;
  let examined = 0;
  const empty = (): Usage => ({ state: 'complete', logicalBytes: 0, regularFiles: 0, skippedEntries: 0 });
  const journal = empty(), attachments = empty(), logs = empty();
  const budget = (usage: Usage): boolean => {
    if (examined >= maxEntries || performance.now() >= deadline) { usage.state = 'partial'; return false; }
    return true;
  };
  const inspect = async (path: string, usage: Usage, expectedExists = false): Promise<Stats | undefined> => {
    if (!budget(usage)) return;
    examined++;
    try { return await lstat(path); }
    catch (error) {
      if (expectedExists || (error as NodeJS.ErrnoException).code !== 'ENOENT') { usage.skippedEntries++; usage.state = 'partial'; }
    }
  };
  const privateDirectory = (info: Stats) => info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const file = async (path: string, usage: Usage, expectedExists = false) => {
    const info = await inspect(path, usage, expectedExists);
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || !Number.isSafeInteger(usage.logicalBytes + info.size)) { usage.skippedEntries++; return; }
    usage.logicalBytes += info.size; usage.regularFiles++;
  };
  const scope = async (path: string, usage: Usage, visit: () => Promise<void>, expectedExists = false) => {
    const before = await inspect(path, usage, expectedExists);
    if (!before) { if (usage.state === 'complete') usage.state = 'missing'; return; }
    if (!privateDirectory(before)) { usage.state = 'unsafe'; usage.skippedEntries++; return; }
    try { await visit(); }
    catch { usage.state = 'unavailable'; usage.skippedEntries++; }
    // Reject an observed directory replacement. This is not descriptor-relative
    // confinement against a malicious process running under the same OS user.
    try {
      const after = await lstat(path);
      if (!privateDirectory(after) || !same(before, after)) throw new Error();
    } catch { usage.state = 'unsafe'; usage.logicalBytes = 0; usage.regularFiles = 0; }
  };
  await scope(dataDir, journal, async () => {
    for (const name of ['bridge.sqlite', 'bridge.sqlite-wal', 'bridge.sqlite-shm', 'worker-lock.sqlite', 'worker-lock.sqlite-journal']) await file(join(dataDir, name), journal);
  });
  // Validate the data parent separately; never traverse an unsafe dataDir even
  // when an attachments subdirectory happens to have private permissions.
  await scope(dataDir, attachments, async () => {
    const base = join(dataDir, 'attachments');
    await scope(base, attachments, async () => {
      const folders = await opendir(base);
      for await (const entry of folders) {
        if (!budget(attachments)) break;
        if (!/^inbound-[A-Za-z0-9_-]+$/.test(entry.name)) { examined++; attachments.skippedEntries++; continue; }
        const path = join(base, entry.name);
        await scope(path, attachments, async () => {
          const entries = await opendir(path);
          for await (const child of entries) {
            if (!budget(attachments)) break;
            await file(join(path, child.name), attachments, true);
          }
        }, true);
        if (attachments.state === 'unsafe' || attachments.state === 'unavailable') break;
      }
    });
  });
  await scope(dirname(configPath), logs, async () => {
    const base = join(dirname(configPath), 'logs');
    await scope(base, logs, async () => {
      for (const name of ['bridge.stdout.log', 'bridge.stderr.log']) await file(join(base, name), logs);
    });
  });
  const usages = [journal, attachments, logs];
  const total = usages.reduce((sum, usage) => sum + usage.logicalBytes, 0);
  return { readOnly: true, approximate: true, totalLogicalBytes: Math.min(total, Number.MAX_SAFE_INTEGER),
    totalIsLowerBound: !Number.isSafeInteger(total) || usages.some(usage => !['complete', 'missing'].includes(usage.state) || usage.skippedEntries > 0), entriesExamined: examined,
    journal, attachments, logs };
}
