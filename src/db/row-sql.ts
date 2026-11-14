export interface RowStatement {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
}
export interface RowDatabase {
    readonly inTransaction?: boolean;
    readonly isTransaction?: boolean;
    prepare(sql: string): RowStatement;
    exec(sql: string): unknown;
}
export function rowLiteral(value: string): string {
    const hex = [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2,'0')).join('');
    return `CAST(X'${hex}' AS TEXT)`;
}
