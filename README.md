# RSA Digital QR Control

MVP full-stack para placas físicas com **QR Code e NFC permanentes**. Cada placa aponta exclusivamente para `go.rsadigitalconsultoria.com.br/{public_code}`; o destino pode mudar no painel sem substituir a arte física.

## Arquitetura

- **Frontend:** React + TypeScript + Vite + Tailwind CSS, painel desktop-first em português.
- **Backend:** Express + tRPC, com operações administrativas protegidas por sessão local assinada e papel `admin`.
- **Banco:** SQLite/libSQL via `@libsql/client`, conectado ao Turso. O banco é acessado exclusivamente no servidor.
- **QR:** public codes aleatórios, não sequenciais, únicos e independentes do ID interno.
- **Público:** resolver de QR que registra scan, redireciona para `google_review_url` manual ou renderiza landing page.
- **Arte:** SVG de impressão, PNG de alta resolução, PDF e ZIP; os arquivos são derivados do registro correto e persistidos no storage.
- **Integrações:** Turso/libSQL, GitHub e Cloudflare DNS. **Não há Manus OAuth, Google Places, Google Places API, busca automática, Place ID ou scraping.**

## Autenticação administrativa

O painel usa login próprio por e-mail e senha. A senha é armazenada somente como hash `scrypt`, a sessão é um cookie `httpOnly` assinado por `JWT_SECRET` e o acesso administrativo exige `role=admin`. O bootstrap inicial usa uma senha temporária gerada fora do código e força a troca no primeiro acesso; não existe senha, token ou segredo versionado no repositório. A recuperação automática de senha por e-mail ainda depende de uma futura configuração de SMTP.

## Fluxo Google Review manual

1. O administrador cola a URL direta de avaliação fornecida pelo Google no campo `google_review_url`.
2. O botão **Testar link** abre a URL em nova aba para validação manual.
3. A URL é validada para aceitar somente `http`/`https` e armazenada no banco.
4. Ao ativar um QR em `GOOGLE_REVIEW`, o resolver usa o destino salvo.
5. A placa física continua apontando somente para `https://go.rsadigitalconsultoria.com.br/{public_code}`.

## Rotas principais

- `/{public_code}` — resolver público; não altera dados administrativos.
- `/api/trpc/admin.dashboard` — indicadores, atividade e scans.
- `/api/trpc/admin.qrs` — inventário, pesquisa e filtros.
- `/api/trpc/admin.createBatch` — geração de lote com unicidade.
- `/api/trpc/admin.generateBatchChunk` — geração incremental de até 10 artes por chamada.
- `/api/trpc/admin.customers` — cadastro e pesquisa de clientes.
- `/api/trpc/admin.createCustomer` — inclui `google_review_url` manual.
- `/api/artwork/{public_code}.svg|png|pdf` — arte individual.
- `/api/batches/{id}.zip` — ZIP de artes do lote.

## Etapa 5 — gerador de lotes e artes para impressão

O botão **Gerar lote** cria os QR Codes em estoque e inicia a produção das artes em blocos de até 10 itens. Cada bloco gera o SVG, PNG e PDF do serial correspondente e grava os três arquivos no storage S3 compatível do ambiente; o manifesto do lote guarda apenas as chaves dos objetos, nunca os bytes no banco.

O lote passa por `GENERATING` para `READY`. O painel mostra o progresso e só libera o ZIP quando todos os itens estão prontos. O endpoint de download monta o ZIP a partir dos arquivos persistidos, evitando uma requisição única de vários minutos e tornando o fluxo compatível com o limite de execução da Vercel. Cada arte contém o QR permanente `https://go.rsadigitalconsultoria.com.br/{public_code}` e a correspondência serial ↔ public code fica registrada no manifesto.

## Etapa 6 — Landing Page e gestão de links

Quando um QR ativo está em `LANDING_PAGE`, o resolver público renderiza uma página própria, mobile-first e sem dependência de Linktree, trackers ou APIs do Google. A página mostra o nome, descrição e logo opcional do cliente, somente os links habilitados e uma identificação discreta da TAG. `GOOGLE_REVIEW` continua sendo um redirecionamento direto para a URL manual cadastrada.

Os tipos aceitos são `GOOGLE_REVIEW`, `INSTAGRAM`, `WHATSAPP`, `PIX`, `WIFI`, `SITE` e `GOOGLE_MAPS`. WhatsApp é normalizado para `wa.me`; Wi-Fi é armazenado como dados estruturados e recebe QR de conexão; Pix é copiado no navegador. Links são ordenados por `position`, podem ser ativados/desativados e removidos pelo painel, sempre com validação de protocolo e sem HTML arbitrário.

O banco existente de `links` foi preservado. A tabela `customers` recebeu apenas `description` e `logo_url`; a inicialização aplica essas duas colunas de forma idempotente para instalações Turso existentes, sem apagar ou duplicar dados.

## Variáveis de ambiente

No ambiente WebDev/Vercel, configure os secrets server-side:

- `TURSO_DATABASE_URL` — URL `libsql://...` do banco.
- `TURSO_AUTH_TOKEN` — token de acesso do banco.
- `JWT_SECRET` — segredo server-side forte para assinar sessões locais.
- `PUBLIC_BASE_URL=https://go.rsadigitalconsultoria.com.br`.
- `APP_BASE_URL=https://app.rsadigitalconsultoria.com.br`.

Por segurança, as credenciais são administradas pelo cofre de secrets do ambiente WebDev; nenhum valor real é commitado. O fallback local usa `file:local.db` apenas quando não há URL Turso.

## Banco e migrations

A migration versionada está em `drizzle/0001_rsa_qr.sql` e cria:

- `users` (incluindo `password_hash` e `must_change_password` para autenticação local)
- `customers` (incluindo `google_review_url`)
- `qr_codes`
- `links`
- `scan_events`
- `audit_logs`
- `batches`

O servidor executa a migration idempotente na primeira conexão. Para aplicar explicitamente em Turso:

```bash
export TURSO_DATABASE_URL='libsql://seu-banco.turso.io'
export TURSO_AUTH_TOKEN='seu-token'
pnpm run db:migrate
```

Para backup simples, exporte o banco no Turso ou execute periodicamente um dump SQL; código e migration devem permanecer no GitHub, nunca apenas em arquivos locais.

## Desenvolvimento

```bash
pnpm install
pnpm dev
pnpm check
pnpm test
pnpm build
```

O painel requer login do administrador; a conta proprietária deve estar com `role=admin` via `OWNER_OPEN_ID`.

## Deploy GitHub → Vercel

1. Conecte `tagbaixada/tagbaixada` à Vercel.
2. Configure os secrets deste README em Production e Preview.
3. Use `pnpm install` e `pnpm build`.
4. Configure `app.rsadigitalconsultoria.com.br` para o painel e `go.rsadigitalconsultoria.com.br` para o resolver.
5. Valide primeiro em Preview antes de promover para produção.

O repositório contém `vercel.json` e handler server-side em `api/index.ts`. O QR físico nunca deve usar `*.vercel.app`.

## Cloudflare e domínio

A inspeção desta sessão não encontrou a zona `rsadigitalconsultoria.com.br` na conta Cloudflare conectada, então nenhum registro foi alterado. Na conta que realmente administra a zona, mantenha o domínio principal intacto e adicione somente os subdomínios necessários com configuração compatível com a Vercel.

## Segurança e privacidade

- SQL parametrizado e validação Zod.
- URLs externas aceitam somente `http/https`; `javascript:` e `data:` são rejeitados.
- Banco e credenciais ficam server-side.
- O endpoint público registra QR, timestamp e user-agent truncado; não persiste IP completo.
- `public_code` não é reutilizado e QR `INACTIVE` não volta automaticamente ao estoque.
