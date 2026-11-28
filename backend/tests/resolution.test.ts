import { isParseableResolution, parseOnInvalid, parseOracleType } from '../src/resolution';

/** Mesma gramática do DB Layer (src/plan/model.ts): o que ele não entende, a homologação recusa. */

test('decisão do e2e da plataforma é aceita como conversão para NULL', () => {
  const text = 'Converter para NULL e registrar no relatório (decisão do DBA)';
  expect(parseOnInvalid(text)).toEqual({ kind: 'null' });
  expect(isParseableResolution(text)).toBe(true);
});

test.each([
  ['Usar VARCHAR2(300 CHAR)', 'VARCHAR2(300 CHAR)'],
  ['varchar2(300)', 'VARCHAR2(300)'],
  ['NVARCHAR2(50)', 'NVARCHAR2(50)'],
  ['Ampliar para NUMBER(10,2)', 'NUMBER(10,2)'],
  ['NUMBER(3)', 'NUMBER(3)'],
  ['CLOB', 'CLOB'],
  ['Manter como DATE', 'DATE'],
  ['TIMESTAMP', 'TIMESTAMP(6)'],
  ['TIMESTAMP(3)', 'TIMESTAMP(3)'],
  ['BOOLEAN', 'BOOLEAN'],
])('tipo Oracle: %s → %s', (text, type) => {
  expect(parseOracleType(text)).toBe(type);
  expect(isParseableResolution(text)).toBe(true);
});

test('data padrão para valores inválidos; 0000-00-00 não vale', () => {
  expect(parseOnInvalid('Usar 1970-01-01 nas datas zeradas')).toEqual({ kind: 'default', value: '1970-01-01' });
  expect(parseOnInvalid('0000-00-00')).toBeNull();
});

test.each(['Truncar em 200', 'Manter NOT NULL', 'ok', 'NUMBER sem precisão', 'VARCHAR(300)', 'anular os valores'])(
  'texto que o DB Layer trocaria pelo tipo declarado: %s',
  (text) => expect(isParseableResolution(text)).toBe(false),
);
