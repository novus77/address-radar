import { execFileSync } from 'node:child_process';
import { type BigIntStats, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readSqliteAdmissionProtectedRecord,
  measureSqliteAdmissionCodeSha256,
} from './sqlite-writer-admission.js';

const CONTROL = '/etc/address-radar/sqlite-writer-admission';
type Source = { path: string; device: string; inode: string };
type CodePin = { path: string; sha256: string };
type BoundaryRecord = {
  version: 1; policySha256: string; source: Source;
  lock: Source; python: CodePin; helper: CodePin; boundaryModuleSha256: string;
};
export type BoundaryLease = { active: boolean; release(): void };
const fail = (): never => { throw new Error('SQLITE_WRITER_BOUNDARY_UNRESOLVED'); };
const need = (value: unknown): void => { if (!value) fail(); };
const keys = (value: object, expected: string[]): void => {
  need(Object.keys(value).sort().join(',') === expected.sort().join(','));
};

export function assertProductionSourceInPolicy(source: Source, policy: { sources: Source[] }): void {
  need(Array.isArray(policy.sources));
  need(policy.sources.filter(item => item.path === source.path
    && item.device === source.device && item.inode === source.inode).length === 1);
}

function readBoundaryRecordUnsafe(): { record: BoundaryRecord; sha256: string } | null {
  if (!existsSync(`${CONTROL}/activation.json`)) return null;
  const activation = readSqliteAdmissionProtectedRecord(`${CONTROL}/activation.json`).value as any;
  const policy = readSqliteAdmissionProtectedRecord(`${CONTROL}/policy.json`);
  const bound = readSqliteAdmissionProtectedRecord(`${CONTROL}/boundary.json`);
  const record = bound.value as BoundaryRecord;
  keys(record, ['version', 'policySha256', 'source', 'lock', 'python', 'helper', 'boundaryModuleSha256']);
  need(record.version === 1 && record.policySha256 === policy.sha256
    && activation.policySha256 === policy.sha256);
  for (const item of [record.source, record.lock]) {
    keys(item, ['path', 'device', 'inode']);
    need(typeof item.path === 'string' && item.path.startsWith('/')
      && typeof item.device === 'string' && /^\d+$/.test(item.device)
      && typeof item.inode === 'string' && /^\d+$/.test(item.inode));
  }
  need(record.lock.path === `${CONTROL}/boundary.lock`);
  for (const item of [record.python, record.helper]) {
    keys(item, ['path', 'sha256']);
    need(typeof item.path === 'string' && item.path.startsWith('/') && /^[0-9a-f]{64}$/.test(item.sha256));
  }
  assertProductionSourceInPolicy(record.source, policy.value as { sources: Source[] });
  assertSourcePinIdentity(record.source, lstatSync(record.source.path, { bigint: true }),
    realpathSync(record.source.path));
  return { record, sha256: bound.sha256 };
}

export function assertSourcePinIdentity(pin: Source, value: BigIntStats, canonicalPath: string): void {
  need(value.isFile() && value.nlink === 1n && canonicalPath === pin.path
    && String(value.dev) === pin.device && String(value.ino) === pin.inode);
}

function readBoundaryRecord(): ReturnType<typeof readBoundaryRecordUnsafe> {
  try { return readBoundaryRecordUnsafe(); } catch { return fail(); }
}

export function assertProductionSourceRegistered(): void { readBoundaryRecord(); }

export function acquireSqliteBoundaryLease(): BoundaryLease {
  const bound = readBoundaryRecord();
  if (!bound) return { active: false, release() {} };
  need(process.platform === 'linux');
  const { record } = bound;
  for (const pin of [record.python, record.helper]) {
    need(measureSqliteAdmissionCodeSha256(pin.path) === pin.sha256);
  }
  need(measureSqliteAdmissionCodeSha256(fileURLToPath(import.meta.url)) === record.boundaryModuleSha256);
  const fd = openSync(record.lock.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let transferred = false;
  try {
    const checkIdentity = () => {
      const value = fstatSync(fd, { bigint: true });
      need(value.isFile() && value.uid === 0n && value.nlink === 1n
        && Number(value.mode & 0o777n) === 0o644
        && String(value.dev) === record.lock.device && String(value.ino) === record.lock.inode);
      const live = readSqliteAdmissionProtectedRecord(`${CONTROL}/boundary.json`);
      need(live.sha256 === bound.sha256);
      const path = lstatSync(record.lock.path, { bigint: true });
      need(path.isFile() && path.uid === 0n && path.nlink === 1n
        && Number(path.mode & 0o777n) === 0o644 && path.dev === value.dev && path.ino === value.ino);
    };
    checkIdentity();
    // flock belongs to this shared open-file description. The helper's exit
    // cannot release it while the parent still owns fd; no lock-holder child.
    execFileSync(record.python.path, ['-I', '-B', record.helper.path,
      '--shared', '--record-sha256', bound.sha256], {
      stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    checkIdentity();
    transferred = true;
    let released = false;
    return { active: true, release() { if (!released) { released = true; closeSync(fd); } } };
  } catch { return fail(); }
  finally { if (!transferred) closeSync(fd); }
}

export function serializeSqliteBoundary<T extends object>(database: T,
  acquire: () => BoundaryLease = acquireSqliteBoundaryLease): T {
  // This is per-call admission serialization, not transaction drainage.
  // BEGIN may outlive its lease; closed admission requires an actual OS drain
  // census before any collector may claim a complete writer fence.
  const exactRollback = (args: unknown[]): boolean => args.length === 1
    && typeof args[0] === 'string' && /^[ \t\r\n]*ROLLBACK[ \t\r\n]*;?[ \t\r\n]*$/i.test(args[0]);
  const statements = new WeakMap<object, object>();
  const wrapStatement = (statement: object): object => {
    const known = statements.get(statement);
    if (known) return known;
    const proxy = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const lease = acquire();
          try {
            // Native streaming finalization can commit RETURNING on return().
            // Activated writers must use get/all/run, which reset before return.
            if (lease.active && property === 'iterate') fail();
            return Reflect.apply(value, target, args);
          } finally { lease.release(); }
        };
      },
      set() { return false; },
    });
    statements.set(statement, proxy);
    return proxy;
  };
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // Cleanup must remain possible when authority, pins or lock acquisition
        // fail. SQL cleanup is only a lexically exact standalone ROLLBACK.
        if ((property === 'close' || property === Symbol.dispose) && args.length === 0) {
          return Reflect.apply(value, target, args);
        }
        if (property === 'exec' && exactRollback(args)) {
          return Reflect.apply(value, target, args);
        }
        const lease = acquire();
        try {
          if (lease.active && property === 'createTagStore') fail();
          const result = Reflect.apply(value, target, args);
          return property === 'prepare' ? wrapStatement(result) : result;
        } finally { lease.release(); }
      };
    },
    set() { return false; },
  });
}
