import { dataLayer } from '../src/clients';

/**
 * Sandbox anonimizado: DB Layer (POST /extract/sample) -> Data Layer
 * (POST /v1/anonymize) -> resumo para a proposta + dataset para a validacao.
 */
const extract = {
  dataset: {
    tables: [{ name: 'clientes', columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'string' }], rows: [[1, 'a@x.com'], [2, 'b@x.com']] }],
  },
  options: { preserve: [] },
};

function anonymized(verdict: 'pass' | 'fail') {
  return {
    run_id: 'run-1',
    dataset: { tables: [{ name: 'clientes', columns: extract.dataset.tables[0].columns, rows: [[7, 'q1@x.com'], [9, 'z2@x.com']] }] },
    report: {
      verdict,
      columns: [
        { column: 'clientes.id', strategy: 'mint_key', total_variation_distance: 0 },
        { column: 'clientes.email', strategy: 'pseudonymize_local_part', total_variation_distance: 0.1 },
      ],
      checks: [{ check: 'leakage', verdict }],
    },
  };
}

function respond(...bodies: unknown[]) {
  const fetchMock = jest.fn();
  for (const b of bodies) fetchMock.mockResolvedValueOnce({ status: 200, ok: true, json: async () => b });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

test('extrai no DB Layer, anonimiza no Data Layer e resume para a proposta', async () => {
  const fetchMock = respond(extract, anonymized('pass'));
  const r = await dataLayer.anonymize({ source: { type: 'mysql', database: 'vendas' }, tables: ['clientes'] });

  expect(fetchMock.mock.calls[0][0]).toMatch(/\/extract\/sample$/);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ tables: ['clientes'] });
  expect(fetchMock.mock.calls[1][0]).toMatch(/\/v1\/anonymize$/);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(extract);

  expect(r).toMatchObject({
    datasetId: 'run-1',
    tables: [{ name: 'clientes', rows: 2, anonymizedColumns: ['id', 'email'] }],
    fidelity: 0.95,
    verdict: 'pass',
  });
  expect(r.dataset).toEqual(anonymized('pass').dataset);
});

test('anonimizacao reprovada (vazamento) interrompe a execucao', async () => {
  respond(extract, anonymized('fail'));
  await expect(dataLayer.anonymize({ source: {}, tables: ['clientes'] })).rejects.toThrow(/reprovou a anonimizacao: leakage/);
});
