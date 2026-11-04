/** A bounded payload plus the legacy exact total, including empty/out-of-range pages. */
export const RECORD_PAGE_SQL = `
WITH matched_count AS (
    SELECT COUNT(*) AS total FROM records WHERE path = ? AND field LIKE ? ESCAPE '\\' AND (? IS NULL OR field > ?)
), page AS (
    SELECT field, value FROM records WHERE path = ? AND field LIKE ? ESCAPE '\\' AND (? IS NULL OR field > ?)
    ORDER BY field LIMIT ? OFFSET ?
)
SELECT matched_count.total, page.field, page.value
FROM matched_count LEFT JOIN page ON 1 = 1 ORDER BY page.field`;

export interface RecordPageRow { total: number; field: string | null; value: string | null }
export interface SidecarRecordPage { total: number; rows: Array<{ field: string; value: unknown }> }

export function recordPageValues(path: string, prefix: string, offset: number, limit: number, after?: string): unknown[] {
    const pattern = prefix.replace(/[\\%_]/g, match => `\\${match}`) + '%';
    return [path, pattern, after ?? null, after ?? null, path, pattern, after ?? null, after ?? null, limit, offset];
}

export function decodeRecordPage(rows: RecordPageRow[]): SidecarRecordPage {
    return { total: rows[0]?.total ?? 0, rows: rows.flatMap(row =>
        row.field === null ? [] : [{ field: row.field, value: JSON.parse(row.value!) }]) };
}
