import { canonical, convertValue, orderTables, TableChecksum, toPostgresValue } from '../../scripts/migrate-sqlite-to-postgres';

describe('SQLite to Postgres conversion', () => {
  it('converts only strict SQLite booleans and preserves nulls', () => {
    expect(convertValue(1n, 'boolean')).toBe(true);
    expect(convertValue(0, 'boolean')).toBe(false);
    expect(convertValue(null, 'boolean')).toBeNull();
    expect(() => convertValue(2, 'boolean')).toThrow('boolean');
    expect(convertValue(1n, 'integer')).toBe('1');
  });

  it('parses JSONB without rewriting encrypted or plain text columns', () => {
    expect(convertValue('{"nested":[true,null,3]}', 'jsonb')).toEqual({ nested: [true, null, 3] });
    expect(() => convertValue('{invalid', 'jsonb')).toThrow();
    expect(convertValue('enc:v1:opaque', 'text')).toBe('enc:v1:opaque');
  });

  it('preserves JSON null separately from SQL NULL during writes and checksums', () => {
    expect(toPostgresValue('null', 'jsonb')).toBe('null');
    expect(toPostgresValue(null, 'jsonb')).toBeNull();
    const columns = [{ column_name: 'payload', data_type: 'jsonb' }];
    expect(canonical({ payload: 'null' }, columns)).not.toBe(canonical({ payload: null }, columns));
    expect(canonical({ payload: '{"b":2,"a":1}' }, columns)).toBe(canonical({ payload: '{"a":1,"b":2}' }, columns));
    expect(toPostgresValue('{"n":9007199254740993}', 'jsonb')).toBe('{"n":9007199254740993}');
    expect(canonical({ payload: '9007199254740993' }, columns)).not.toBe(canonical({ payload: '9007199254740992' }, columns));
    expect(canonical({ payload: '1.00e3' }, columns)).toBe(canonical({ payload: '1000' }, columns));
    expect(canonical({ payload: '[1, {"nested": "escaped \\\" quote"}, null]' }, columns)).toBe(
      canonical({ payload: '[1.0,{"nested":"escaped \\\" quote"},null]' }, columns),
    );
  });

  it('preserves nullable timestamps, epoch units and 64-bit precision', () => {
    expect(convertValue(null, 'bigint')).toBeNull();
    expect(convertValue(1720000000123n, 'bigint')).toBe('1720000000123');
    expect(convertValue(9007199254740993n, 'bigint')).toBe('9007199254740993');
  });

  it('orders dependencies and rejects cycles', () => {
    expect(orderTables(['child', 'parent'], new Map([['child', ['parent']]]))).toEqual(['parent', 'child']);
    expect(() => orderTables(['a', 'b'], new Map([['a', ['b']], ['b', ['a']]]))).toThrow('cycle');
  });

  it('checksums are order independent but sensitive to duplicates and changes', () => {
    const checksum = (rows: string[]) => { const result = new TableChecksum(); rows.forEach(row => result.add(row)); return result.digest(); };
    expect(checksum(['a', 'b', 'a'])).toBe(checksum(['b', 'a', 'a']));
    expect(checksum(['a', 'b'])).not.toBe(checksum(['a', 'b', 'a']));
    expect(checksum(['a', 'c'])).not.toBe(checksum(['a', 'b']));
  });
});
