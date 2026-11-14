import {FSError} from '@nestos/vfs-core/protocol';
import {SEQ_ROW_COMMANDS,type SeqRowCommand,type SeqRowSchema} from '@nestos/vfs-core/seq';
import {SEQ_ROW_SCHEMA_FIELD,validateRowDefinition,validateRowQuery,rowSchemaChange} from '@nestos/vfs-core/seq/driver';
import type {RowDatabase} from './row-sql';
import {rowLiteral} from './row-sql';
import {rowLayoutDDL} from './row-triggers';
import {queryStructuredRows} from './row-query';

interface StoredSchema {schema: SeqRowSchema; storage: number;}
function layout(schema: SeqRowSchema): string {
    return JSON.stringify({keyPrefix:schema.keyPrefix,columns:schema.columns,indexes:schema.indexes});
}
function metadata(db: RowDatabase, path: string): StoredSchema | null {
    const row = db.prepare('SELECT value FROM records WHERE path=? AND field=?').get(path,SEQ_ROW_SCHEMA_FIELD) as {value:string} | undefined;
    if (!row) return null;
    try {
        const stored = JSON.parse(row.value) as StoredSchema;
        if (!Number.isSafeInteger(stored.storage) || stored.storage < 1 || !Number.isSafeInteger(stored.schema.version)
            || stored.schema.version < 1) throw new Error('Invalid layout reference');
        return stored;
    } catch {throw new FSError('EIO','Structured row layout is unavailable or inconsistent','seq.rows');}
}
function define(db: RowDatabase, path: string, input: unknown): SeqRowSchema {
    const next = validateRowDefinition(input), previous = metadata(db,path);
    if (!rowSchemaChange(previous?.schema ?? null,next)) return previous!.schema;
    const encoded = layout(next.schema);
    db.prepare('INSERT OR IGNORE INTO vfs_row_layouts(layout) VALUES (?)').run(encoded);
    const {id} = db.prepare('SELECT id FROM vfs_row_layouts WHERE layout=?').get(encoded) as {id:number};
    if (!Number.isSafeInteger(id) || id < 1) throw new FSError('EIO','Invalid structured layout identity','seq.rows');
    if (previous?.storage !== id) db.exec(rowLayoutDDL(id,next.schema));
    db.prepare(`INSERT INTO records(path,field,value) VALUES (?,?,?) ON CONFLICT(path,field) DO UPDATE SET value=excluded.value`)
        .run(path,SEQ_ROW_SCHEMA_FIELD,JSON.stringify({schema:next.schema,storage:id}));
    if (previous && previous.storage !== id) releaseLayout(db,previous.storage);
    return next.schema;
}
function releaseLayout(db: RowDatabase, id: number): void {
    const marker = rowLiteral(SEQ_ROW_SCHEMA_FIELD);
    if (db.prepare(`SELECT 1 FROM records WHERE field=${marker} AND json_extract(value,'$.storage')=? LIMIT 1`).get(id)) return;
    for (const suffix of ['ins','upd','del','schema_ins','schema_upd']) db.exec(`DROP TRIGGER IF EXISTS vfs_rows_${id}_${suffix}`);
    db.exec(`DROP TABLE IF EXISTS vfs_rows_${id}`);
    db.prepare('DELETE FROM vfs_row_layouts WHERE id=?').run(id);
}
function defineAtomic(db: RowDatabase, path: string, input: unknown): SeqRowSchema {
    db.exec('SAVEPOINT vfs_seq_rows_define');
    try {
        const schema = define(db,path,input); db.exec('RELEASE vfs_seq_rows_define'); return schema;
    } catch (error) {
        db.exec('ROLLBACK TO vfs_seq_rows_define'); db.exec('RELEASE vfs_seq_rows_define'); throw error;
    }
}
export function clearStructuredRecords(db: RowDatabase, path: string, recursive = false): void {
    db.exec('SAVEPOINT vfs_seq_rows_clear');
    try {
        const scope = recursive ? "(path=? OR substr(path,1,length(?)+1)=? || '/')" : 'path=?';
        const parameters = recursive ? [path,path,path] : [path];
        const layouts = db.prepare(`SELECT DISTINCT json_extract(value,'$.storage') AS id FROM records
            WHERE ${scope} AND field=?`).all(...parameters,SEQ_ROW_SCHEMA_FIELD) as Array<{id:number}>;
        db.prepare(`DELETE FROM records WHERE ${scope}`).run(...parameters);
        for (const {id} of layouts) if (Number.isSafeInteger(id) && id > 0) releaseLayout(db,id);
        db.exec('RELEASE vfs_seq_rows_clear');
    } catch (error) {
        db.exec('ROLLBACK TO vfs_seq_rows_clear'); db.exec('RELEASE vfs_seq_rows_clear'); throw error;
    }
}
export function structuredRowControl(db: RowDatabase, path: string, command: SeqRowCommand, input?: unknown): unknown {
    try {
        if (!Object.hasOwn(SEQ_ROW_COMMANDS,command)) throw new FSError('ECAPABILITY','Unsupported structured row command','seq.rows');
        if (command === 'seq.rows.define.v1') return defineAtomic(db,path,input);
        return readAtomic(db,() => readControl(db,path,command,input));
    } catch (error) {throw structuredRowError(error);}
}
function readControl(db: RowDatabase, path: string, command: SeqRowCommand, input?: unknown): unknown {
    const stored = metadata(db,path);
    if (command === 'seq.rows.describe.v1') {
        if (input !== undefined) throw new FSError('EINVAL','Schema inspection accepts no input','seq.rows');
        return stored?.schema ?? null;
    }
    if (!stored) throw new FSError('ECAPABILITY','SeqFile has no structured row schema','seq.rows');
    return queryStructuredRows(db,stored.storage,path,stored.schema,validateRowQuery(stored.schema,input));
}
function readAtomic<T>(db: RowDatabase, read: () => T): T {
    if (db.inTransaction || db.isTransaction) return read();
    db.exec('SAVEPOINT vfs_seq_rows_read');
    try {const result = read(); db.exec('RELEASE vfs_seq_rows_read'); return result;}
    catch (error) {db.exec('ROLLBACK TO vfs_seq_rows_read'); db.exec('RELEASE vfs_seq_rows_read'); throw error;}
}
export function structuredRowError(error: unknown): unknown {
    if (error instanceof FSError) return error;
    const message = (error as Error)?.message ?? '';
    const column = /SEQ_ROWS_COLUMN_INVALID:([A-Za-z_][A-Za-z0-9_]{0,63})/.exec(message);
    if (column) return new FSError('ETYPEMISMATCH',`Structured column ${column[1]} has an invalid type or size`,'seq.rows');
    if (message.includes('SEQ_ROWS_OBJECT_REQUIRED')) return new FSError('ETYPEMISMATCH','Structured entries require a JSON object','seq.rows');
    if (message.includes('seq_rows_key_size')) return new FSError('EINVAL','Structured row key exceeds the size limit','seq.rows');
    if (/UNIQUE constraint failed: vfs_rows_\d+\./.test(message)) return new FSError('ECONFLICT','Unique structured row index conflict','seq.rows');
    if (/no such table: vfs_rows_\d+/.test(message)) return new FSError('EIO','Structured row layout is missing','seq.rows');
    if (/no such column: c\d+/.test(message)) return new FSError('EIO','Structured row layout column is missing','seq.rows');
    return error;
}
