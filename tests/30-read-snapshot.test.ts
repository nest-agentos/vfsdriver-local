import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalFSBackend} from '../src/localfs-backend';
import {BetterSqliteSidecarDb} from '../src/db/sidecar';
import {NodeFsOps} from '../src/fs/node-fs-ops';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'read-snapshot-'));
    cleanup.push(() => rm(root, {recursive: true, force: true}));
    const fs = new NodeFsOps(); let db!: BetterSqliteSidecarDb;
    const backend = new LocalFSBackend({rootDir: join(root, 'files'), sidecarDir: join(root, 'db'), createFs: () => fs,
        createDb: async path => (db = new BetterSqliteSidecarDb(path))});
    await backend.init(); cleanup.push(() => backend.close());
    await backend.write('/old.seq', new Uint8Array());
    await backend.records.setRecordField('/old.seq', 'state', 'kept');
    return {root, backend, db, fs};
}
it('reads while another connection owns the SQLite writer without reserving a writer', async () => {
    const {root, backend} = await fixture();
    const writer = new BetterSqliteSidecarDb(join(root, 'db/index.db'));
    await writer.begin();
    try {
        backend.resetSidecarStats();
        expect(await backend.records.getRecordField('/old.seq', 'state')).toBe('kept');
        expect(backend.sidecarStats.begin).toBe(0);
        expect(backend.sidecarStats.readTransaction).toBe(1);
    } finally {await writer.rollback(); await writer.close();}
});
it('retries metadata when another backend renames during filesystem I/O', async () => {
    const {root, backend, fs} = await fixture();
    const writer = new LocalFSBackend({rootDir: join(root, 'files'), sidecarDir: join(root, 'db')});
    await writer.init(); cleanup.push(() => writer.close());
    const original = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementationOnce(async path => {
        const stale = await original(path);
        await writer.rename('/old.seq', '/new.seq');
        return stale;
    });
    expect(await backend.stat('/old.seq')).toBeNull();
    expect(await backend.records.getRecordField('/new.seq', 'state')).toBe('kept');
});
it('recovers a committed rename intent before returning records', async () => {
    const {root, backend, db} = await fixture();
    await db.begin();
    await db.setRecordField('/__vfs_namespace_journal__', 'next-rename', 1);
    await db.setRecordField('/__vfs_namespace_journal__', 'intent', {id: 1, fromPath: '/old.seq', toPath: '/new.seq'});
    await db.commit();
    await rename(join(root, 'files/old.seq'), join(root, 'files/new.seq'));
    expect(await backend.records.getRecordField('/new.seq', 'state')).toBe('kept');
    expect(await backend.records.getRecordField('/old.seq', 'state')).toBeUndefined();
});
