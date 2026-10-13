# Backend Core — orquestrador de migração (protótipo)

O Backend Core recebe as requisições do Front-end e as valida com Zod. Ele controla o estado da migração no PostgreSQL e aciona DB Layer, AI Layer e Data Layer na ordem de cada operação, sem executar tarefas especializadas. Os layers podem rodar como **mocks HTTP** (padrão, respostas fixas) ou **reais**: DB Layer e AI Layer já estão integrados (ver "Integração com os layers reais"). Com o Data Layer real, a execução também fica real. A plataforma completa (todos os serviços + front) sobe pelo repositório `placeholder-platform`.

```
Front-end ──HTTP──▶ Backend Core (Express) ──▶ DB Layer   :4002 (mock)
                       │      │            ──▶ AI Layer   :4001 (mock)
                       │      │            ──▶ Data Layer :4003 (mock)
                       ▼      └─ logs (pino)
                  PostgreSQL (migrations, migration_events)
```

## Como rodar

```bash
docker compose up --build        # backend :3000, mocks :4001-4003, postgres :5433
```

O build dos containers já instala as dependências de `backend/` e `mocks/`: não é preciso rodar `npm install` nessas pastas para subir o projeto.

Com tudo no ar, rode o roteiro de demonstração a partir da raiz (só precisa do Node 18+, sem `npm install`):

```bash
npm run demo            # cria → analisa → decide o DEFER e aprova → executa → COMPLETED
npm run demo:reject     # analisa e rejeita a proposta → REJECTED
npm run demo:invalid    # tenta executar sem aprovação → 409
npm run demo:deferred   # tenta aprovar sem decidir o DEFER da IA → 422
```

Cada comando cria uma migração nova, espera os status em background e imprime os conflitos (e quem decidiu cada um), o sandbox, a validação, o resultado e a trilha de auditoria. Para outro endereço: `BASE_URL=http://host:porta npm run demo`.

Para disparar as requisições uma a uma, use o [`requests.http`](requests.http): no VS Code, com a extensão REST Client; fora dele, copie os comandos para o curl.

Os testes rodam fora do Docker, então este é o único passo que pede `npm install` (em `backend/`):

```bash
cd backend && npm install && npm test
```

## Fluxo

`CREATED → ANALYZING → WAITING_APPROVAL → APPROVED → EXECUTING → VALIDATING → COMPLETED`
(ou `REJECTED` na homologação, ou `FAILED` quando um layer falha ou a validação reprova)

| Etapa | O que o Backend orquestra |
| --- | --- |
| Análise (`ANALYZING`) | DB Layer testa as conexões, lê a estrutura da origem e classifica os conflitos. Os mecânicos saem resolvidos por regra; cada conflito de julgamento vai para a AI Layer, que responde `PROPOSE` (com evidência) ou `DEFER`. |
| Homologação (`WAITING_APPROVAL`) | O usuário aprova ou rejeita. Conflito em `DEFER` exige uma decisão humana no corpo do `approve`; sem ela a resposta é `422`. |
| Execução (`EXECUTING`) | DB Layer extrai a amostra da origem e o Data Layer a anonimiza (sandbox). |
| Validação (`VALIDATING`) | DB Layer carrega o dataset anonimizado num schema SANDBOX nos tipos do plano e roda as verificações. Reprovou: `FAILED`, sem escrita no destino. Aprovou: o DB Layer real gera o **script de migração** (`PLAN_SCRIPT_READY`) e a migração vai a `COMPLETED`; com os mocks, o plano é dado como aplicado (`PLAN_APPLIED`). |

| Endpoint | O que faz |
| --- | --- |
| `POST /migrations` | cria a migração (`CREATED`); destino `oracle` ou `postgres` |
| `GET /migrations`, `GET /migrations/:id` | consulta, sem usuário e senha da origem |
| `POST /migrations/:id/analyze` | inicia a análise (202, em background) |
| `POST /migrations/:id/approve` | aprova; corpo opcional `{ "decisions": [{ "conflictId", "resolution" }] }` |
| `POST /migrations/:id/reject` | rejeita; corpo opcional `{ "reason" }` |
| `POST /migrations/:id/execute` | inicia a execução (202, em background) |
| `GET /migrations/:id/events` | trilha de auditoria |

Respostas de erro: `400` dados inválidos ou conflito inexistente, `404` migração não encontrada, `409` transição inválida (por exemplo, executar sem aprovação), `422` decisão humana pendente.

Na proposta, cada conflito traz `decidedBy` (`rule`, `ai` ou `human`) e `status` (`RESOLVED` ou `DEFERRED`). Além das mudanças de status, a auditoria grava `PROPOSAL_CREATED`, `PROPOSAL_APPROVED` (com as decisões humanas), `PROPOSAL_REJECTED`, `SANDBOX_READY`, `PLAN_VALIDATED`, `PLAN_SCRIPT_READY` (DB Layer real) ou `PLAN_APPLIED` (mocks), `MIGRATION_COMPLETED` e `MIGRATION_FAILED`.

## Contratos dos layers

O que o Backend chama em cada layer. Os mocks em [`mocks/src/index.ts`](mocks/src/index.ts) respondem exatamente a isso.

| Layer | Chamada | Origem do contrato |
| --- | --- | --- |
| DB Layer | `POST /connections/test` | documento da Fase 6 |
| DB Layer | `GET /schema/introspect?connection=source` | documento; o DB Layer real aceita `connection` e `side` |
| DB Layer | `POST /schema/diff` | documento |
| DB Layer | `POST /extract/sample` | amostra da origem no formato do Data Layer |
| DB Layer | `POST /validate/plan` | documento; o DB Layer real carrega o dataset anonimizado no schema SANDBOX e roda as 5 verificações |
| DB Layer | `POST /plan/apply` | o DB Layer real **gera o script de migração** (`applied: false`, `mode: "script"`) e não escreve no destino |
| AI Layer | `POST /ai/analyze-conflict` | contrato real da AI Layer (o documento citava `/ai/chat`, que é o chat livre) |
| Data Layer | `POST /v1/anonymize` | contrato real do Data Layer (recebe as linhas extraídas pelo DB Layer) |

O formato dos corpos JSON (em [`backend/src/schemas.ts`](backend/src/schemas.ts)) também é suposição, a confirmar com os responsáveis por cada layer na integração.

## Plataforma completa (layers reais)

Com os mocks, o Core roda sozinho, como acima. Com **todos os layers reais** (DB Layer, AI Layer,
Data Layer, bancos de demonstração e front-end), use o repositório
[`placeholder-platform`](https://github.com/pedrolombardi/placeholder-platform): um
`docker compose up --build` e o teste ponta a ponta (`npm run e2e`).

## Simular falhas

Troque o modo dos mocks e rode `npm run demo` de novo:

```bash
npm run mocks:fail:ai          # AI Layer responde 500 → retry → FAILED na análise
npm run mocks:fail:db          # DB Layer responde 500 → FAILED no teste de conexão
npm run mocks:fail:data        # Data Layer responde 500 → FAILED ao gerar o sandbox, depois do execute
npm run mocks:fail:validation  # plano reprovado no sandbox → FAILED, sem escrita no destino
npm run mocks:ok               # volta ao normal
```

Esses scripts (`scripts/mocks.mjs`, funcionam também no PowerShell) recriam o container dos mocks com `FAIL=ai|db|data` ou `VALIDATION_FAIL=true`.

## Código (`backend/src`)

| Arquivo           | Papel                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| `routes.ts`       | mapa rota → controller |
| `controllers.ts`  | recebem a requisição, validam, chamam o service e disparam o orchestrator em background |
| `schemas.ts`      | contratos Zod das requisições e das respostas dos layers; formato da proposta |
| `service.ts`      | casos de uso, máquina de estados, regra do `DEFER` e eventos de auditoria |
| `orchestrator.ts` | ordem das chamadas aos layers e montagem da proposta; qualquer erro leva a migração a `FAILED` |
| `clients.ts`      | clientes dos três layers, com timeout (3s) e até 2 retries em erro de rede, timeout ou 5xx; traduz a resposta da AI Layer para o formato do orchestrator |
| `repository.ts`   | queries no PostgreSQL                                                         |
