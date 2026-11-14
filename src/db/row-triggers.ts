import {SEQ_FIELD_PREFIX, type SeqRowColumn, type SeqRowSchema} from '@nestos/vfs-core/seq';
import {SEQ_ROW_SCHEMA_FIELD} from '@nestos/vfs-core/seq/driver';
import {recordPrefixBounds} from './record-page';
import {rowLiteral} from './row-sql';

function prefix(schema: SeqRowSchema, field: string): string {
    const [lower,upper] = recordPrefixBounds(SEQ_FIELD_PREFIX + schema.keyPrefix);
    return `${field} >= ${rowLiteral(lower)} AND ${field} < ${upper === null ? "CAST(x'FF' AS TEXT)" : rowLiteral(upper)}`;
}
function active(id: number, path: string): string {
    return `EXISTS(SELECT 1 FROM records s WHERE s.path=${path} AND s.field=${rowLiteral(SEQ_ROW_SCHEMA_FIELD)} AND json_extract(s.value,'$.storage')=${id})`;
}
function invalidSurrogate(value: string): string {
    const hex = `hex(CAST(${value} AS BLOB))`;
    return `(CASE WHEN instr(${hex},'ED')=0 THEN 0 ELSE EXISTS(
        WITH RECURSIVE positions(i) AS (SELECT 1 UNION ALL SELECT i+2 FROM positions WHERE i<length(${hex}))
        SELECT 1 FROM positions WHERE substr(${hex},i,6) GLOB 'ED[AB][0-9A-F][89AB][0-9A-F]') END)`;
}
function extract(column: string, definition: SeqRowColumn, source: string): string {
    const object = `json_extract(${source},'$')`, value = `json_extract(${object},'$.${column}')`, type = `json_type(${object},'$.${column}')`;
    const mismatch = definition.type === 'text' ? `${type} IS NOT 'text' OR length(CAST(${value} AS BLOB))>4096 OR ${invalidSurrogate(value)}`
        : definition.type === 'boolean' ? `${type} NOT IN ('true','false')`
        : definition.type === 'integer' ? `${type} IS NOT 'integer' OR ${value} NOT BETWEEN -9007199254740991 AND 9007199254740991`
        : `${type} NOT IN ('integer','real') OR ${value} NOT BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308`;
    const missing = `(${type} IS NULL OR ${type}='null')`;
    return `CASE WHEN json_valid(${object}) IS NOT 1 THEN RAISE(ABORT,'SEQ_ROWS_OBJECT_REQUIRED')
        WHEN json_type(${object}) IS NOT 'object' THEN RAISE(ABORT,'SEQ_ROWS_OBJECT_REQUIRED')
        WHEN ${missing} THEN ${definition.nullable ? 'NULL' : `RAISE(ABORT,'SEQ_ROWS_COLUMN_INVALID:${column}')`}
        WHEN ${mismatch} THEN RAISE(ABORT,'SEQ_ROWS_COLUMN_INVALID:${column}') ELSE ${value} END`;
}
function insertRows(id: number, schema: SeqRowSchema, source: string, path: string, field: string, where: string): string {
    const values = Object.entries(schema.columns).map(([name,column]) => extract(name,column,`${source}.value`));
    const fields = Object.keys(schema.columns).map((_,i) => `c${i}`);
    return `INSERT INTO vfs_rows_${id}(path,field,${fields.join(',')})
        SELECT ${path},${field},${values.join(',')} ${source === 'NEW' ? '' : `FROM records ${source}`} WHERE ${where}
        ON CONFLICT(path,field) DO UPDATE SET ${fields.map(field => `${field}=excluded.${field}`).join(',')};`;
}
export function rowLayoutDDL(id: number, schema: SeqRowSchema): string {
    const columns = Object.values(schema.columns).map((column,i) => `c${i} ${column.type === 'text' ? 'TEXT' : column.type === 'real' ? 'REAL' : 'INTEGER'}${column.nullable ? '' : ' NOT NULL'}`);
    const keyLimit = 4096 + new TextEncoder().encode(SEQ_FIELD_PREFIX).length;
    return `CREATE INDEX IF NOT EXISTS vfs_seq_row_schemas ON records(field) WHERE field=${rowLiteral(SEQ_ROW_SCHEMA_FIELD)};
        CREATE TABLE IF NOT EXISTS vfs_rows_${id}(path TEXT NOT NULL,field TEXT NOT NULL CONSTRAINT seq_rows_key_size CHECK(length(CAST(field AS BLOB))<=${keyLimit}),${columns.join(',')},PRIMARY KEY(path,field));`
        + rowIndexes(id,schema) + rowTriggers(id,schema);
}
function rowIndexes(id: number, schema: SeqRowSchema): string {
    return (schema.indexes ?? []).map((index,i) => {
        const fields = Object.keys(schema.columns);
        const columns = index.columns.map(order => `c${fields.indexOf(order.column)} ${order.direction.toUpperCase()}`);
        if (!index.unique) columns.push('field ASC');
        return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS vfs_rows_${id}_i${i} ON vfs_rows_${id}(path,${columns.join(',')});`;
    }).join('\n');
}
function rowTriggers(id: number, schema: SeqRowSchema): string {
    const table = `vfs_rows_${id}`, marker = rowLiteral(SEQ_ROW_SCHEMA_FIELD);
    const rowInsert = insertRows(id,schema,'NEW','NEW.path','NEW.field',`${prefix(schema,'NEW.field')} AND ${active(id,'NEW.path')}`);
    const backfill = insertRows(id,schema,'r','r.path','r.field',`r.path=NEW.path AND ${prefix(schema,'r.field')}`);
    return `CREATE TRIGGER IF NOT EXISTS ${table}_ins AFTER INSERT ON records BEGIN ${rowInsert} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_upd AFTER UPDATE ON records BEGIN
          DELETE FROM ${table} WHERE path=OLD.path AND (field=OLD.field OR
            (OLD.field=${marker} AND (NEW.field<>${marker} OR NEW.path<>OLD.path OR json_extract(NEW.value,'$.storage') IS NOT ${id})));
          ${rowInsert} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_del AFTER DELETE ON records BEGIN
          DELETE FROM ${table} WHERE path=OLD.path AND (field=OLD.field OR OLD.field=${marker}); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_schema_ins AFTER INSERT ON records
          WHEN NEW.field=${marker} AND json_extract(NEW.value,'$.storage')=${id} BEGIN ${backfill} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_schema_upd AFTER UPDATE ON records
          WHEN NEW.field=${marker} AND json_extract(NEW.value,'$.storage')=${id}
          AND (OLD.field<>${marker} OR OLD.path<>NEW.path OR json_extract(OLD.value,'$.storage') IS NOT ${id}) BEGIN
          DELETE FROM ${table} WHERE path=NEW.path; ${backfill} END;`;
}
