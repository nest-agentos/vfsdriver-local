import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalFSBackend} from '../src/localfs-backend';
import {SEQ_FIELD_PREFIX,type SeqRowSchema,type SeqRowPage,type SeqRowQuery} from '@nestos/vfs-core/seq';
import {SEQ_ROW_SCHEMA_FIELD} from '@nestos/vfs-core/seq/driver';
import {compileRowQuery} from '../src/db/row-query';
import {MemoryBackend} from '@nestos/vfs-core/testing';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const schema: SeqRowSchema = {version:1,keyPrefix:'run:',columns:{state:{type:'integer'},time:{type:'integer'},label:{type:'text',nullable:true}},
    indexes:[{name:'state_time',columns:[{column:'state',direction:'asc'},{column:'time',direction:'desc'}]}]};
const query: SeqRowQuery = {select:['time'],where:{column:'state',op:'eq',value:1},orderBy:[{column:'time',direction:'desc'}],limit:2};
async function fixture() {
    const root = await mkdtemp(join(tmpdir(),'seq-structured-')); cleanup.push(() => rm(root,{recursive:true,force:true}));
    const backend = new LocalFSBackend({rootDir:join(root,'data'),sidecarDir:join(root,'meta')}); await backend.init(); cleanup.push(() => backend.close());
    const write = (key: string, value: unknown) => backend.records.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+key,JSON.stringify(value));
    const define = (value = schema, expectedVersion: number | null = null) => backend.records.transaction!(tx => tx.rowControl!('/rows.seq','seq.rows.define.v1',{schema:value,expectedVersion}));
    const page = (value = query) => backend.records.readTransaction!(tx => tx.rowControl!('/rows.seq','seq.rows.query.v1',value)) as Promise<SeqRowPage>;
    return {root,backend,write,define,page};
}

it('uses real typed columns and a covering index without reading row JSON for projected pages', async () => {
    const f = await fixture();
    for (const [key,state,time] of [['a',1,9],['b',1,9],['c',1,4],['d',0,7]] as const)
        await f.write('run:'+key,{state,time,label:null,cold:'PRIVATE_COLD_BODY'.repeat(200)});
    await f.write('detail:a','unstructured cold detail'); await f.define();
    const db = (f.backend as any).db, native = db.db, spy = vi.spyOn(native,'prepare');
    const first = await f.page();
    expect(first.rows).toEqual([{key:'run:a',values:{time:9}},{key:'run:b',values:{time:9}}]);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_COLD_BODY');
    expect((await f.page({...query,after:first.next})).rows).toEqual([{key:'run:c',values:{time:4}}]);
    const select = spy.mock.calls.map(([sql]) => String(sql)).find(sql => sql.startsWith('SELECT field,') && sql.includes('FROM vfs_rows_'));
    expect(select).toContain('FROM vfs_rows_'); expect(select).not.toContain('json_extract'); expect(select).not.toContain('value');
    const metadata = await db.getRecordField('/rows.seq',SEQ_ROW_SCHEMA_FIELD), compiled = compileRowQuery(metadata.storage,'/rows.seq',metadata.schema,query);
    const plan = native.prepare('EXPLAIN QUERY PLAN '+compiled.sql).all(...compiled.parameters);
    expect(plan.some((item: any) => item.detail.includes('COVERING INDEX vfs_rows_'))).toBe(true);
    expect(native.prepare(`SELECT typeof(c1) AS kind FROM vfs_rows_${metadata.storage} LIMIT 1`).get().kind).toBe('integer');
});

it('keeps ordinary updates and deletes synchronized and rolls schema, data and receipts back together', async () => {
    const f = await fixture(); await f.define(); await f.write('run:a',{state:1,time:1});
    await f.write('run:a',{state:1,time:5}); expect((await f.page()).rows[0].values.time).toBe(5);
    await expect(f.backend.records.transaction!(async tx => {
        await tx.rowControl!('/rows.seq','seq.rows.define.v1',{schema:{...schema,version:2},expectedVersion:1});
        await tx.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a','{"state":1,"time":99}');
        await tx.setRecordField('/receipt.seq','accepted',true); throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await f.page()).rows[0].values.time).toBe(5);
    expect(await f.backend.records.getRecordField('/receipt.seq','accepted')).toBeUndefined();
    expect(await f.backend.records.rowControl!('/rows.seq','seq.rows.describe.v1')).toMatchObject({version:1});
    await expect(f.write('run:a',{state:'PRIVATE_INVALID',time:5})).rejects.toMatchObject({code:'ETYPEMISMATCH'});
    expect((await f.page()).rows[0].values.time).toBe(5);
    await f.backend.records.deleteRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a'); expect((await f.page()).rows).toEqual([]);
});

it('rejects invalid migrations atomically and does not replace a different row on unique-index conflicts', async () => {
    const f = await fixture(); await f.write('run:a',{state:1,time:1}); await f.write('run:b',{state:1,time:2}); await f.define();
    const native = (f.backend as any).db.db, before = native.prepare('SELECT count(*) AS n FROM vfs_row_layouts').get().n;
    await expect(f.define({...schema,version:2,columns:{...schema.columns,missing:{type:'text'}}},1)).rejects.toMatchObject({code:'ETYPEMISMATCH'});
    expect(native.prepare('SELECT count(*) AS n FROM vfs_row_layouts').get().n).toBe(before);
    await f.define({...schema,version:2,indexes:[{name:'time_unique',columns:[{column:'time',direction:'asc'}],unique:true}]},1);
    await expect(f.write('run:b',{state:1,time:1})).rejects.toMatchObject({code:'ECONFLICT'});
    expect((await f.page()).rows).toEqual([{key:'run:b',values:{time:2}},{key:'run:a',values:{time:1}}]);
});

it('moves schemas and projections with durable rename and clears them when deleting and recreating the path', async () => {
    const f = await fixture(); await f.backend.write('/rows.seq',new Uint8Array());
    await f.write('run:a',{state:1,time:4}); await f.define();
    await f.backend.rename('/rows.seq','/moved.seq');
    const moved = await f.backend.records.rowControl!('/moved.seq','seq.rows.query.v1',query) as SeqRowPage;
    expect(moved.rows).toEqual([{key:'run:a',values:{time:4}}]);
    expect(await f.backend.records.rowControl!('/rows.seq','seq.rows.describe.v1')).toBeNull();
    await f.backend.delete('/moved.seq'); await f.backend.write('/moved.seq',new Uint8Array());
    expect(await f.backend.records.rowControl!('/moved.seq','seq.rows.describe.v1')).toBeNull();
    expect((f.backend as any).db.db.prepare('SELECT count(*) AS n FROM vfs_row_layouts').get().n).toBe(0);
});

it('holds a read snapshot without reserving the writer and sees later writes on the next query', async () => {
    const f = await fixture(); await f.define(); await f.write('run:a',{state:1,time:1});
    const other = new LocalFSBackend({rootDir:join(f.root,'data'),sidecarDir:join(f.root,'meta')}); await other.init(); cleanup.push(() => other.close());
    await f.backend.records.readTransaction!(async tx => {
        expect(((await tx.rowControl!('/rows.seq','seq.rows.query.v1',query)) as SeqRowPage).rows[0].values.time).toBe(1);
        await other.records.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a','{"state":1,"time":2}');
        expect(((await tx.rowControl!('/rows.seq','seq.rows.query.v1',query)) as SeqRowPage).rows[0].values.time).toBe(1);
    });
    expect((await f.page()).rows[0].values.time).toBe(2);
});

it('matches the portable reference for nested filters, nulls, literal Unicode and mixed cursor orders', async () => {
    const f = await fixture(), memory = new MemoryBackend(); await memory.init(); cleanup.push(() => memory.close());
    const labels = ['A','a','中文','😀','\ue000',null,'with\0zero','\ufeffbom'];
    for (let i = 0; i < 24; i++) {
        const value = {state:i%3,time:i%5,label:labels[i%labels.length]};
        await f.write('run:'+i,value); await memory.records.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:'+i,JSON.stringify(value));
    }
    await f.define(); await memory.records.rowControl('/rows.seq','seq.rows.define.v1',{schema,expectedVersion:null});
    const queries: SeqRowQuery[] = [
        {select:['time','label'],where:{and:[{column:'time',op:'gte',value:1},{column:'time',op:'lt',value:4}]},limit:3},
        {select:['state'],where:{or:[{column:'label',op:'eq',value:null},{column:'state',op:'eq',value:1}]},orderBy:[{column:'label',direction:'asc'},{column:'time',direction:'desc'}],limit:2},
        {select:['label'],where:{column:'label',op:'in',values:[null,'A','中文']},orderBy:[{column:'label',direction:'desc'}],limit:1},
        {select:['time'],where:{column:'label',op:'ne',value:'A'},orderBy:[{column:'label',direction:'asc'}],limit:5},
        {select:['label'],where:{column:'label',op:'ne',value:null},orderBy:[{column:'label',direction:'desc'},{column:'state',direction:'asc'}],limit:4},
    ];
    for (const base of queries) {
        let after: string | undefined;
        do {
            const input = {...base,...(after ? {after} : {})}, actual = await f.page(input);
            expect(actual).toEqual(await memory.records.rowControl('/rows.seq','seq.rows.query.v1',input)); after = actual.next;
        } while (after);
    }
});


it('seeks keys with a covering primary index without reading bodies or counting all matches', async () => {
    const f=await fixture();
    for (const key of ['x%_a','x%_b','x%_中','x-other']) await f.write(key,'PRIVATE_COLD_BODY'.repeat(1000));
    const db=(f.backend as any).db,spy=vi.spyOn(db.db,'prepare');
    try {
        expect(await f.backend.records.getRecordKeys!('/rows.seq',{prefix:SEQ_FIELD_PREFIX+'x%_',limit:2})).toEqual([SEQ_FIELD_PREFIX+'x%_a',SEQ_FIELD_PREFIX+'x%_b']);
        expect(await f.backend.records.getRecordKeys!('/rows.seq',{prefix:SEQ_FIELD_PREFIX+'x%_',after:SEQ_FIELD_PREFIX+'x%_b',limit:2})).toEqual([SEQ_FIELD_PREFIX+'x%_中']);
        const queries=spy.mock.calls.map(call=>String(call[0])).filter(sql=>sql.includes('SELECT field FROM records'));
        expect(queries.length).toBe(2);expect(queries.every(sql=>!sql.includes('COUNT(')&&!sql.includes('value'))).toBe(true);
        const {recordKeysQuery}=await import('../src/db/record-keys');
        const q=recordKeysQuery('/rows.seq',{prefix:SEQ_FIELD_PREFIX+'x%_',limit:2});
        expect(JSON.stringify(db.db.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values))).toContain('COVERING INDEX');
    } finally {spy.mockRestore();}
});
