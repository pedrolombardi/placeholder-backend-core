/**
 * Gramática das resoluções em texto livre que o DB Layer entende
 * (`src/plan/model.ts` do DB Layer: `parseOracleType` e `parseOnInvalid`).
 * Uma resolução fora dela é trocada em silêncio pelo tipo declarado no destino,
 * por isso a homologação recusa o texto antes de gravá-lo.
 * As expressões regulares são cópia fiel das do DB Layer: mudou lá, muda aqui.
 */

/** Tipo Oracle citado no texto ("Usar VARCHAR2(300 CHAR)"), reconstruído a partir das partes. */
export function parseOracleType(text: string): string | null {
  const t = text.toUpperCase();
  let m = /\b(VARCHAR2|NVARCHAR2|NCHAR|CHAR)\s*\(\s*(\d{1,5})\s*(CHAR|BYTE)?\s*\)/.exec(t);
  if (m) {
    const base = m[1]!;
    const national = base.startsWith('N');
    const semantics = national || m[3] === 'CHAR' ? 'CHAR' : 'BYTE';
    return `${base}(${Number(m[2])}${semantics === 'CHAR' && !national ? ' CHAR' : ''})`;
  }
  m = /\bNUMBER\s*\(\s*(\d{1,2})\s*(?:,\s*(\d{1,2})\s*)?\)/.exec(t);
  if (m) {
    const scale = m[2] !== undefined ? Number(m[2]) : 0;
    return scale ? `NUMBER(${Number(m[1])},${scale})` : `NUMBER(${Number(m[1])})`;
  }
  m = /\b(CLOB|NCLOB|BINARY_DOUBLE|BINARY_FLOAT|BOOLEAN|DATE)\b/.exec(t);
  if (m) return m[1]!;
  m = /\bTIMESTAMP(?:\s*\(\s*(\d)\s*\))?/.exec(t);
  if (m) return `TIMESTAMP(${m[1] !== undefined ? Number(m[1]) : 6})`;
  return null;
}

export type OnInvalid = { kind: 'null' } | { kind: 'default'; value: string };

/** Decisão sobre valores inválidos: "... para NULL" ou uma data padrão AAAA-MM-DD. */
export function parseOnInvalid(text: string): OnInvalid | null {
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (date && date[1] !== '0000-00-00') return { kind: 'default', value: date[1]! };
  if (/\bNULL\b/i.test(text) && !/\bNOT\s+NULL\b/i.test(text)) return { kind: 'null' };
  return null;
}

/** O DB Layer aplica a resolução quando ela cita um tipo Oracle ou uma decisão sobre valores inválidos. */
export const isParseableResolution = (text: string) => parseOracleType(text) !== null || parseOnInvalid(text) !== null;

export const RESOLUTION_HINT =
  'cite um tipo Oracle (ex.: VARCHAR2(300 CHAR), NUMBER(10,2), CLOB, TIMESTAMP) ' +
  'ou a decisão sobre valores inválidos (ex.: "Converter para NULL", ou uma data padrão AAAA-MM-DD)';
