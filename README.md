# Backend Core — orquestrador de migração (protótipo)

O Backend Core recebe as requisições do Front-end e as valida com Zod. Ele controla o estado da migração no PostgreSQL e aciona DB Layer, AI Layer e Data Layer na ordem de cada operação, sem executar tarefas especializadas. Os layers podem rodar como **mocks HTTP** (padrão, respostas fixas) ou **reais** (ver "Plataforma completa"). A plataforma completa (todos os serviços + front) sobe pelo repositório `placeholder-platform`.

Na Fase 7 (MVP), o Core ganhou **login com perfis** (só o DBA homologa e executa), **autor em cada evento da auditoria** e **métricas** para o Dashboard (`GET /metrics`).

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

Neste compose a autenticação está **ligada** (`AUTH_ENABLED=true`). Usuários de demonstração, criados no primeiro boot: `dba` / `dba123` (perfil DBA) e `qa` / `qa123` (perfil DEV_QA).

O build dos containers já instala as dependências de `backend/` e `mocks/`: não é preciso rodar `npm install` nessas pastas para subir o projeto.

Com tudo no ar, rode o roteiro de demonstração a partir da raiz (só precisa do Node 18+, sem `npm install`):

```bash
npm run demo            # cria → analisa → decide o DEFER e aprova → executa → COMPLETED
npm run demo:reject     # analisa e rejeita a proposta → REJECTED
npm run demo:invalid    # tenta executar sem aprovação → 409
npm run demo:deferred   # tenta aprovar sem decidir o DEFER da IA → 422
npm run demo:rbac       # qa (DEV_QA) cria e analisa, recebe 403 ao aprovar; dba aprova e executa
npm run metrics         # só imprime o GET /metrics
```

Cada comando cria uma migração nova, espera os status em background e imprime os conflitos (e quem decidiu cada um), o sandbox, a validação, o resultado, a trilha de auditoria (com o autor de cada evento) e as métricas. O roteiro consulta o `/health`: se a autenticação estiver ligada, ele faz login sozinho (`DEMO_DBA_USER`/`DEMO_DBA_PASSWORD` e `DEMO_QA_USER`/`DEMO_QA_PASSWORD` trocam os usuários). Para outro endereço: `BASE_URL=http://host:porta npm run demo`.

Para disparar as requisições uma a uma, use o [`requests.http`](requests.http): no VS Code, com a extensão REST Client; fora dele, copie os comandos para o curl.

Os testes rodam fora do Docker, então este é o único passo que pede `npm install` (em `backend/`):

```bash
cd backend && npm install && npm test     # 27 testes: fluxo, contratos dos layers, login/RBAC e métricas
```

## MVP: Fase 7, Parte 1

| Requisito da atividade | Onde está no Core |
| --- | --- |
| Funcionalidades essenciais da Fase 6 | Análise (regra × IA), homologação com decisão humana obrigatória para DEFER, sandbox anonimizado, validação e script de migração |
| Fluxo principal executável | `docker compose up --build` + `npm run demo` (mocks) ou a plataforma completa com o front em http://localhost:8080 |
| Persistência | PostgreSQL: `migrations`, `migration_events` (auditoria com autor) e `users` (senhas com hash scrypt) |
| Interface | API REST (abaixo) consumida pelo front-end (`placeholder-front`) |
| Tecnologia Oracle | Oracle Database 23ai, acionado pelo Core através do DB Layer (abaixo) |

### Onde a Oracle entra no fluxo que o Core orquestra

Pela arquitetura (`ARQUITETURA.md`), só o DB Layer acessa os bancos de migração. O Core não conecta direto no Oracle: ele decide **quando** cada etapa acontece e o que fazer com o resultado.

| Etapa | Chamada do Core | O que acontece no Oracle 23ai |
| --- | --- | --- |
| Análise | `POST /schema/diff` | O DB Layer lê o catálogo do destino (schema `VENDAS`) para comparar com o MySQL e classificar os conflitos |
| Validação | `POST /validate/plan` | O dataset anonimizado é carregado no schema **`SANDBOX`** nos tipos do plano aprovado. Truncamento, FKs, precisão e nulos são verificados num Oracle real. Se reprovar, o Core leva a migração a `FAILED` e não sai script |
| Script | `POST /plan/apply` | Script de migração para o Oracle (`VARCHAR2(... CHAR)`, `IDENTITY`, `CLOB`, `JSON` nativo do 23ai), entregue ao DBA |

O DB Layer usa o driver oficial `node-oracledb` (modo thin).

## Fluxo

`CREATED → ANALYZING → WAITING_APPROVAL → APPROVED → EXECUTING → VALIDATING → COMPLETED`
(ou `REJECTED` na homologação, ou `FAILED` quando um layer falha ou a validação reprova)

| Etapa | O que o Backend orquestra |
| --- | --- |
| Análise (`ANALYZING`) | DB Layer testa as conexões, lê a estrutura da origem e classifica os conflitos. Os mecânicos saem resolvidos por regra; cada conflito de julgamento vai para a AI Layer, que responde `PROPOSE` (com evidência) ou `DEFER`. |
| Homologação (`WAITING_APPROVAL`) | O usuário aprova ou rejeita. Conflito em `DEFER` exige uma decisão humana no corpo do `approve`; sem ela a resposta é `422`. |
| Execução (`EXECUTING`) | DB Layer extrai a amostra da origem e o Data Layer a anonimiza (sandbox). |
| Validação (`VALIDATING`) | DB Layer carrega o dataset anonimizado num schema SANDBOX nos tipos do plano e roda as verificações. Reprovou: `FAILED`, sem escrita no destino. Aprovou: o DB Layer real gera o **script de migração** (`PLAN_SCRIPT_READY`) e a migração vai a `COMPLETED`; com os mocks, o plano é dado como aplicado (`PLAN_APPLIED`). |

| Endpoint | Perfil | O que faz |
| --- | --- | --- |
| `GET /health` | público | `{ status, auth }`: se o banco responde e se a autenticação está ligada |
| `POST /auth/login` | público | `{ username, password }` → `{ token, tokenType, expiresIn, user }` |
| `GET /auth/me` | qualquer | usuário do token |
| `POST /migrations` | qualquer | cria a migração (`CREATED`); destino `oracle` ou `postgres` |
| `GET /migrations`, `GET /migrations/:id` | qualquer | consulta, sem usuário e senha da origem |
| `POST /migrations/:id/analyze` | qualquer | inicia a análise (202, em background) |
| `POST /migrations/:id/approve` | **DBA** | aprova; corpo opcional `{ "decisions": [{ "conflictId", "resolution" }] }` |
| `POST /migrations/:id/reject` | **DBA** | rejeita; corpo opcional `{ "reason" }` |
| `POST /migrations/:id/execute` | **DBA** | inicia a execução (202, em background) |
| `GET /migrations/:id/events` | qualquer | trilha de auditoria, com o autor (`actor`) de cada evento |
| `GET /metrics` | qualquer | métricas do Dashboard (abaixo) |

Respostas de erro: `400` dados inválidos ou conflito inexistente, `401` sem token ou token inválido, `403` perfil sem permissão (por exemplo, DEV_QA aprovando), `404` migração não encontrada, `409` transição inválida (por exemplo, executar sem aprovação), `422` decisão humana pendente.

## Autenticação e perfis

| Perfil | Pode |
| --- | --- |
| `DBA` | tudo, inclusive homologar (aprovar/rejeitar) e executar |
| `DEV_QA` | criar, analisar e consultar migrações, auditoria e métricas |

As rotas protegidas pedem `Authorization: Bearer <token>` (JWT HS256, validade de 8 h). As senhas ficam no PostgreSQL com hash scrypt e salt. Na auditoria, `actor` é o usuário que fez a ação. Vale `system` para o que o Core faz em background (análise e execução) e `anonymous` quando a autenticação está desligada. Na proposta aprovada, o conflito decidido por humano traz `decidedByUser`.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `AUTH_ENABLED` | `false` | `true` liga login e perfis. Desligada, toda requisição vale como DBA anônimo, que é o comportamento da Fase 6, usado pelo front e pela plataforma enquanto o front não manda token |
| `JWT_SECRET` | aleatório no boot | segredo de assinatura dos tokens. Sem ele, os tokens deixam de valer quando o processo reinicia |
| `JWT_EXPIRES_IN` | `8h` | validade do token |
| `AUTH_SEED_USERS` | `dba:dba123:DBA,qa:qa123:DEV_QA` | usuários criados no boot quando a tabela `users` está vazia |

No boot, o Core aplica o schema de forma idempotente (`repository.ensureSchema`): cria `users` e acrescenta a coluna `actor` em volumes criados na Fase 6, sem apagar dados.

## Métricas (`GET /metrics`)

Calculadas a partir do estado e da trilha de auditoria (`metrics.ts`, função pura):

- `migrations`: total, `byStatus`, `inProgress`, `waitingApproval` e `successRate` (COMPLETED ÷ terminadas);
- `conflicts`: total, `byDecidedBy` (`rule`, `ai`, `human`), `pendingHuman` e `deferredByAi`;
- `stageDurations`: média em ms e contagem de `analysis`, `approval`, `execution`, `validation` e `total`;
- `failuresByStage`: em que status as migrações falharam.

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
| `server.ts`       | boot: aplica o schema, cria os usuários iniciais e abre a porta |
| `app.ts`          | monta o Express (health, rotas, tratamento de erros); usado também pelos testes |
| `routes.ts`       | mapa rota → controller, com autenticação e perfil exigido |
| `auth.ts`         | login, hash de senha (scrypt), JWT, middlewares `authenticate` e `requireRole` |
| `metrics.ts`      | métricas do Dashboard a partir das migrações e da auditoria |
| `controllers.ts`  | recebem a requisição, validam, chamam o service e disparam o orchestrator em background |
| `schemas.ts`      | contratos Zod das requisições e das respostas dos layers; formato da proposta |
| `service.ts`      | casos de uso, máquina de estados, regra do `DEFER` e eventos de auditoria |
| `orchestrator.ts` | ordem das chamadas aos layers e montagem da proposta; qualquer erro leva a migração a `FAILED` |
| `clients.ts`      | clientes dos três layers, com timeout (3s) e até 2 retries em erro de rede, timeout ou 5xx; traduz a resposta da AI Layer para o formato do orchestrator |
| `repository.ts`   | queries no PostgreSQL (migrações, auditoria, usuários) e schema idempotente     |
