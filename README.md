# Só Armação — Backend de pagamento (Asaas)

Pix dinâmico + cartão de crédito, em Vercel Serverless Functions.
O front (Claude Design / GitHub) nunca vê a chave de API e nunca decide preço.

---

## Por que existe um backend

A doc do Asaas é explícita: *"Não informe sua chave de API (...) ou exponha no
front-end da sua aplicação."* Uma página do Claude Design é HTML entregue ao
navegador — qualquer pessoa com o link lê o código-fonte. Chave no front =
qualquer um cria, consulta e estorna cobrança na conta do Só Armação.

Além disso, preço calculado no navegador é preço editável pelo comprador.
Aqui o navegador manda só `{ sku, qty }`; quem calcula é o servidor.

---

## Arquitetura

```
Navegador (Claude Design / front no GitHub)
   │  POST /api/checkout   { itens: [{sku, qty}], cliente, metodo }
   ▼
Vercel Function  ── recalcula preço ──► Supabase (grava pedido)
   │                                         ▲
   │  POST /payments (access_token)          │
   ▼                                         │
  ASAAS ──────── webhook PAYMENT_RECEIVED ──►│ /api/webhook-asaas
                                             │   ├─ valida token
                                             │   ├─ confere valor
                                             │   ├─ marca PAGO
                                             │   └─ dispara conversão
                                             ▼
                              Meta CAPI · GA4 MP · n8n → Bling (NF-e/estoque)
```

**O webhook é a fonte da verdade.** O `Purchase` só sobe quando o Asaas
confirma o dinheiro — nunca na tela de "obrigado", que qualquer um recarrega.

---

## Arquivos

| Arquivo | Função |
|---|---|
| `api/checkout.js` | Cria cliente + cobrança. Pix devolve QR; cartão devolve URL do checkout hospedado. |
| `api/webhook-asaas.js` | Recebe eventos do Asaas. Autentica, deduplica, confere valor, dispara tracking. |
| `api/pedido/[id].js` | Polling de status da tela de Pix. |
| `lib/asaas.js` | Cliente HTTP. Único lugar que toca a chave. |
| `lib/catalogo.js` | **Autoridade de preço.** Leve 2/3, frete, piso de R$ 89,90. |
| `lib/tracking.js` | Fan-out server-side: Meta CAPI, GA4 MP. |
| `lib/validacao.js` | CPF/e-mail/CEP, hash LGPD, comparação em tempo constante. |
| `lib/carregar-env.js` | Lê o `vercel-env.txt` nos scripts, pra chave nenhuma ir pro histórico. |
| `db/schema.sql` | Tabelas, RLS e as views de reconciliação. |
| `scripts/configurar.sh` | Gera os segredos, coleta as chaves e envia pra Vercel. |
| `scripts/smoke-test.js` | Confere conta, chave Pix, webhook e env vars. |
| `scripts/testa-precos.js` | 12 testes da regra de preço (rodam offline). |
| `scripts/testa-validacao.js` | 16 testes de validação/segurança. |

---

## Setup — o que **você** faz

> As três primeiras etapas envolvem credenciais. Eu não gero, não copio e não
> colo chave de API — isso passa por você. O resto já está pronto no código.

### 1. Gerar a chave de sandbox
1. Crie/acesse a conta em **https://sandbox.asaas.com** (é um login separado da produção).
2. Menu do perfil → **Integrações** → **Gerar API Key**.
3. Copie a chave (começa com `$aact_hmlg_`). Ela aparece **uma vez só**.

### 2. Criar o projeto na Vercel

> `vercel link` só liga a pasta a um projeto **que já existe**. Como ainda não
> existe nenhum, quem cria o projeto é o primeiro deploy.

```bash
cd so-armacao-checkout      # a pasta que saiu do zip
npm install
npx vercel login
npx vercel                  # <- é ESTE comando que cria o projeto
```

O CLI vai perguntar, nesta ordem:

| Pergunta | Responda |
|---|---|
| Set up and deploy "…/so-armacao-checkout"? | **Y** |
| Which scope do you want to deploy to? | sua conta |
| Link to existing project? | **N** ← é aqui que você tinha travado |
| What's your project's name? | `so-armacao-checkout` |
| In which directory is your code located? | `./` |
| Want to modify these settings? | **N** |

Terminou, você tem um projeto na Vercel e uma URL de preview. Ainda não
funciona — faltam as variáveis.

### 2b. Preencher as variáveis

**Pelo terminal (mais rápido e mais seguro):**

```bash
bash scripts/configurar.sh
```

Ele gera os dois segredos sozinho, pergunta os três valores externos sem
ecoar na tela, grava o `vercel-env.txt` com permissão `600` e oferece mandar
tudo pra Vercel de uma vez. Nada passa pelo histórico do shell.

**Ou pelo painel, à mão:**

1. Abra `vercel-env.txt` (vai junto no zip), preencha os valores e **não salve
   esse arquivo no Git**.
2. Vercel → seu projeto → **Settings → Environment Variables**.
3. Clique em **Import .env** (ou cole tudo de uma vez no campo de import) e
   marque **Production**.
4. Salve.

Gere os segredos assim:
```bash
openssl rand -hex 32     # rode 2x: um pro ASAAS_WEBHOOK_TOKEN, outro pro CPF_HASH_SALT
```

### 2c. Subir pra valer

```bash
npx vercel --prod
```

Anote a URL final (`https://so-armacao-checkout.vercel.app`). Ela é o
`API_BASE` que vai no campo **apiBase** dos Tweaks do Claude Design, e a base
da URL do webhook no passo 3.

> **Alternativa sem CLI:** suba a pasta pra um repositório no GitHub e, no
> painel da Vercel, **Add New → Project → Import Git Repository**. As variáveis
> entram pela mesma tela de Settings, e cada push passa a fazer deploy sozinho.
> Se um dia o front do Só Armação for pro mesmo repositório, some o CORS —
> front e API no mesmo domínio.

### 3. Cadastrar o webhook no Asaas
Painel → **Integrações → Webhooks → Adicionar**:

| Campo | Valor |
|---|---|
| URL | `https://SEU-DOMINIO.vercel.app/api/webhook-asaas` |
| Versão | v3 |
| E-mail | seu e-mail (recebe aviso se a fila pausar) |
| Token de autenticação | **o mesmo** `ASAAS_WEBHOOK_TOKEN` |
| Tipo de envio | Sequencial |
| Eventos | `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED` |

### 4. Registrar uma chave Pix
Painel → **Pix → Minhas chaves**. Sem chave registrada, **o QR expira às 23:59
do mesmo dia**. Com chave, vale meses. É o erro mais comum da integração.

### 5. Banco
Cole `db/schema.sql` no SQL Editor do Supabase. Depois ajuste a tabela
`produtos` com os SKUs e preços reais.

### 6. Conferir
```bash
node scripts/smoke-test.js
node scripts/testa-precos.js && node scripts/testa-validacao.js
```

O smoke-test lê o `vercel-env.txt` da pasta sozinho.

> **Nunca passe a chave na linha de comando.** Além de ficar no histórico do
> shell, a chave do Asaas começa com `$` — sem aspas simples o zsh trata
> `$aact_hmlg_...` como nome de variável, não acha nada, e manda string vazia.

### 7. Ir pra produção
1. Gere a chave de **produção** (painel do www.asaas.com, mesmo caminho).
2. Troque `ASAAS_API_KEY` e ponha `ASAAS_ENV=production` na Vercel.
3. Cadastre o webhook **de novo** na conta de produção (são contas separadas).
4. Ative a **whitelist de IP** no Asaas com os IPs de saída da Vercel.
5. Faça um pedido real de R$ 89,90 e estorne.

---

## Taxas — impacto na margem

Sua planilha de custeio assume gateway a **3,99% + R$ 0,49**. O Asaas cobra
Pix por **valor fixo**, o que muda a conta no seu ticket:

| Ticket | Planilha (3,99% + 0,49) | Asaas Pix (R$ 1,99) | Diferença |
|---|---|---|---|
| R$ 89,90 | R$ 4,08 | R$ 1,99 | **+R$ 2,09** |
| R$ 189,90 (kit 2) | R$ 8,07 | R$ 1,99 | **+R$ 6,08** |

No cenário de 300 pedidos/mês com lucro de ~R$ 11,13/armação, os R$ 2,09
são **~19% a mais de lucro por unidade** — sem mexer em mídia nem em preço.
Nos 3 primeiros meses a taxa é R$ 0,99, o que amplia a diferença.

Cartão continua percentual: 2,99% + R$ 0,49 à vista, 3,49% em 2-6x,
3,99% em 7-12x. Ou seja, **quanto mais Pix no mix, melhor a margem** —
vale um desconto à vista no Pix pra empurrar o mix.

---

## Decisões de segurança embutidas

- Chave de API só no servidor, via env var; nunca em código ou log.
- Preço, desconto e frete recalculados no servidor a cada pedido.
- Webhook autenticado por token com comparação em tempo constante.
- Idempotência por `id` do evento (o Asaas reenvia).
- Valor pago conferido contra o valor do pedido antes de liberar.
- CPF nunca persistido cru — só `SHA-256(CPF + salt)`.
- RLS ligado: `anon key` não lê pedido nenhum.
- CORS restrito por `ALLOWED_ORIGINS`.
- Cartão via checkout hospedado: dado de cartão não passa pelo nosso servidor,
  o que mantém o escopo PCI-DSS no mínimo (SAQ-A).

## Operação

- `v_pedidos_pendentes_antigos` — pedidos parados há 2h+ (webhook falhou?).
- `v_tracking_falho` — vendas cujo Purchase não subiu pro Meta/GA4.

Rode as duas diariamente. É a reconciliação pedidos × eventos que você pediu.
