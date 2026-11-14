/** Use binary key bounds so SQLite can seek both parts of the composite primary key. */
export const RECORD_FIELD_RANGE="field >= ? AND field < COALESCE(?, CAST(x'FF' AS TEXT))";
export function recordPrefixBounds(prefix:string):[string,string|null] {
    const normalized=new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(prefix)),points=Array.from(normalized);
    for(let index=points.length-1;index>=0;index--) {
        const code=points[index].codePointAt(0)!;if(code===0x10ffff)continue;
        const next=code===0xd7ff?0xe000:code+1;
        return [normalized,points.slice(0,index).join('')+String.fromCodePoint(next)];
    }
    return [normalized,null];
}
/** A bounded payload plus the legacy exact total, including empty/out-of-range pages. */
export const RECORD_PAGE_SQL = `
WITH matched_count AS (
    SELECT COUNT(*) AS total FROM records WHERE path = ? AND ${RECORD_FIELD_RANGE} AND (? IS NULL OR field > ?)
), page AS (
    SELECT field, value FROM records WHERE path = ? AND ${RECORD_FIELD_RANGE} AND (? IS NULL OR field > ?)
    ORDER BY field LIMIT ? OFFSET ?
)
SELECT matched_count.total, page.field, page.value
FROM matched_count LEFT JOIN page ON 1 = 1 ORDER BY page.field`;

export interface RecordPageRow { total: number; field: string | null; value: string | null }
export interface SidecarRecordPage { total: number; rows: Array<{ field: string; value: unknown }> }

export function recordPageValues(path: string, prefix: string, offset: number, limit: number, after?: string): unknown[] {
    const [lower,upper]=recordPrefixBounds(prefix);
    return [path,lower,upper,after??null,after??null,path,lower,upper,after??null,after??null,limit,offset];
}

export function decodeRecordPage(rows: RecordPageRow[]): SidecarRecordPage {
    return { total: rows[0]?.total ?? 0, rows: rows.flatMap(row =>
        row.field === null ? [] : [{ field: row.field, value: JSON.parse(row.value!) }]) };
}
