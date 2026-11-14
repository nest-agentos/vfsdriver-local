import {FSError,type RecordKeysOptions} from '@nestos/vfs-core/protocol';
import {compareUtf8} from '@nestos/vfs-core/seq/driver';
import {recordPrefixBounds} from './record-page';

export function recordKeysQuery(path: string, options: RecordKeysOptions): {sql:string;values:unknown[]} {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 501)
        throw new FSError('EINVAL','Record key page size must be 1–501');
    const [lower,upper] = recordPrefixBounds(options.prefix ?? '');
    const after = options.after === undefined ? undefined : recordPrefixBounds(options.after)[0];
    const exclusive = after !== undefined && compareUtf8(after,lower) >= 0;
    return {sql:`SELECT field FROM records WHERE path=? AND field ${exclusive ? '>' : '>='} ?
        AND field<COALESCE(?,CAST(x'FF' AS TEXT)) ORDER BY field LIMIT ?`,
        values:[path,exclusive ? after : lower,upper,options.limit]};
}
