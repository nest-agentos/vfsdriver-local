import {SEQ_FIELD_PREFIX, type SeqRowPredicate, type SeqRowQuery,
    type SeqRowScalar, type SeqRowSchema} from '@nestos/vfs-core/seq';
import {makeRowPage,readRowCursor,type SeqRowCursor} from '@nestos/vfs-core/seq/driver';
import type {RowDatabase} from './row-sql';

function scalar(value: SeqRowScalar): string | number | null {return typeof value === 'boolean' ? Number(value) : value;}
function predicate(schema: SeqRowSchema, value: SeqRowPredicate, parameters: unknown[]): string {
    if ('and' in value) return '(' + value.and.map(item => predicate(schema,item,parameters)).join(' AND ') + ')';
    if ('or' in value) return '(' + value.or.map(item => predicate(schema,item,parameters)).join(' OR ') + ')';
    const column = `c${Object.keys(schema.columns).indexOf(value.column)}`;
    if (value.op === 'in') {
        const values = value.values.filter(item => item !== null); parameters.push(...values.map(scalar));
        const clauses = values.length ? [`${column} IN (${values.map(() => '?').join(',')})`] : [];
        if (value.values.includes(null)) clauses.push(`${column} IS NULL`);
        return '(' + clauses.join(' OR ') + ')';
    }
    if (value.value === null) return `${column} IS ${value.op === 'ne' ? 'NOT ' : ''}NULL`;
    parameters.push(scalar(value.value));
    const operators = {eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>='};
    return `${column} ${operators[value.op]} ?`;
}
function cursorCondition(schema: SeqRowSchema, query: SeqRowQuery, cursor: SeqRowCursor, parameters: unknown[]): string {
    const columns = Object.keys(schema.columns), orders = query.orderBy ?? [], terms: string[] = [];
    for (let position = 0; position <= orders.length; position++) {
        const equal = orders.slice(0,position).map((order,index) => {
            parameters.push(scalar(cursor.order[index])); return `c${columns.indexOf(order.column)} IS ?`;
        });
        if (position === orders.length) {
            parameters.push(SEQ_FIELD_PREFIX + cursor.key); equal.push('field > ?');
        } else {
            const order = orders[position], column = `c${columns.indexOf(order.column)}`, value = cursor.order[position];
            equal.push(cursorTerm(column,order.direction,value,parameters));
        }
        terms.push('(' + equal.join(' AND ') + ')');
    }
    return '(' + terms.join(' OR ') + ')';
}
function cursorTerm(column: string, direction: 'asc' | 'desc', value: SeqRowScalar, parameters: unknown[]): string {
    if (value === null) return direction === 'asc' ? `${column} IS NOT NULL` : '0';
    parameters.push(scalar(value));
    return direction === 'asc' ? `${column} > ?` : `(${column} < ? OR ${column} IS NULL)`;
}
export function compileRowQuery(id: number, path: string, schema: SeqRowSchema, query: SeqRowQuery) {
    const columns = Object.keys(schema.columns), projected = [...new Set([...query.select,...(query.orderBy ?? []).map(order => order.column)])];
    const parameters: unknown[] = [path], where = ['path=?'];
    if (query.where) where.push(predicate(schema,query.where,parameters));
    const cursor = readRowCursor(path,schema,query);
    if (cursor) where.push(cursorCondition(schema,query,cursor,parameters));
    const selected = projected.map(name => `c${columns.indexOf(name)}`);
    const order = (query.orderBy ?? []).map(item => `c${columns.indexOf(item.column)} ${item.direction.toUpperCase()}`);
    parameters.push(query.limit + 1); order.push('field ASC');
    return {sql:`SELECT field,${selected.join(',')} FROM vfs_rows_${id} WHERE ${where.join(' AND ')} ORDER BY ${order.join(',')} LIMIT ?`,parameters,projected};
}
export function queryStructuredRows(db: RowDatabase, id: number, path: string, schema: SeqRowSchema, query: SeqRowQuery) {
    const compiled = compileRowQuery(id,path,schema,query), columns = Object.keys(schema.columns);
    const found = db.prepare(compiled.sql).all(...compiled.parameters) as Array<Record<string,SeqRowScalar>>;
    const rows = found.map(row => ({key:(row.field as string).slice(SEQ_FIELD_PREFIX.length), values:Object.fromEntries(compiled.projected.map(name => {
        const value = row[`c${columns.indexOf(name)}`]; return [name,schema.columns[name].type === 'boolean' && value !== null ? Boolean(value) : value];
    }))}));
    return makeRowPage(path,schema,query,rows);
}
