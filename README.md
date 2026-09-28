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
| `api/catalogo.js` | Catálogo público (JSON) que a loja lê: modelos, cores, preços, estoque, facetas dos filtros. |
| `api/cotar.js` | Cotação do carrinho pela mesma regra do checkout (preço, 30% no 2º óculos, frete). A loja nunca calcula sozinha. |
| `api/bling/auth.js` · `callback.js` | Conexão OAuth com o Bling (uma vez; o token renova sozinho). |
| `api/bling/sync.js` | Sincroniza o catálogo inteiro Bling → `produtos` (cron diário + à mão). |
| `api/bling/webhook.js` | Recebe produto/estoque do Bling em tempo real (assinatura HMAC). |
| `api/bling/migrar-tags.js` | Uma vez: cria os campos customizados (Gênero, Material, Ocasião, Tom de pele) e copia as tags. |
| `api/bling/corrigir-descricoes.js` | Uma vez: tira "garantia de 1 ano e troca em até 30 dias" das descrições no Bling (vira "troca grátis em até 7 dias úteis"). `?somente=ver` só mostra. |
| `lib/feed.js` (via `/api/catalogo?feed=`) | Feed de produtos pro catálogo do Meta (`/api/feed/meta.csv`, CSV) e pro Merchant Center (`/api/feed/google.tsv`): uma linha por SKU, agrupadas pelo pai, com as 3 fotos, preço, estoque e atributos. As plataformas buscam a URL sozinhas. |
| `lib/bling.js` | Cliente da API v3 do Bling: tokens, refresh, limite de 3 req/s. |
| `lib/catalogo-sync.js` | Mapeamento produto do Bling → linha de `produtos` (uma por cor). |
| `lib/catalogo.js` | **Autoridade de preço.** Preço e estoque da tabela `produtos`, desconto de 30% só no 2º óculos, frete. |
| `lib/tracking.js` | Fan-out server-side: Meta CAPI, GA4 MP. |
| `lib/validacao.js` | CPF/e-mail/CEP, hash LGPD, comparação em tempo constante. |
| `lib/carregar-env.js` | Lê o `vercel-env.txt` nos scripts, pra chave nenhuma ir pro histórico. |
| `db/schema.sql` | Tabelas, RLS e as views de reconciliação. |
| `db/migracao-catalogo-bling.sql` | Colunas do catálogo Bling, limpeza dos produtos de teste, fim do piso de preço, tabelas de tokens/log. |
| `scripts/configurar.sh` | Gera os segredos, coleta as chaves e envia pra Vercel. |
| `scripts/smoke-test.js` | Confere conta, chave Pix, webhook e env vars. |
| `scripts/testa-precos.js` | 16 testes da regra de preço e estoque (rodam offline). |
| `scripts/testa-sync.js` | 10 testes do mapeamento Bling → produtos e das assinaturas (offline). |
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

## Catálogo — Bling é a fonte da verdade

A tabela `produtos` não é mais editada à mão: ela é uma cópia do Bling. Uma
linha por **variação** (modelo + cor), que é o que se vende e tem estoque; o
produto pai entra denormalizado (nome, formato, gênero, material, ocasião,
tom de pele, descrição, medidas).

```
Bling ──(cron diário /api/bling/sync)──► produtos ◄──(webhook produto/estoque)── Bling
                                            │
                    /api/catalogo (loja) ◄──┴──► /api/cotar + /api/checkout (preço/estoque)
```

De onde vem cada campo: **formato** = categoria do Bling (Gatinho, Redondo…);
**gênero / material / ocasião / tom de pele** = campos customizados do produto
pai (a API v3 não expõe tags — por isso os campos); **cor** = atributo `Cor:` da
variação; **preço e estoque** = da variação (saldo virtual); **fotos** = URLs
externas (jsDelivr); **lente / ponte / haste** = lidos da descrição
("Lente 55mm · ponte 17mm · haste 140mm").

### Ligar (uma vez)

1. **App no Bling** — developer.bling.com.br → Criar aplicativo. URL de
   redirecionamento `https://api.soarmacao.com.br/api/bling/callback`. Escopos:
   Produtos, Estoques, Categorias de produtos, Campos customizados (Pedidos de
   venda e Notas fiscais podem entrar já, pra próxima fase).
2. **Variáveis na Vercel** (pelo CLI, nunca pelo painel):
   `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`. `CRON_SECRET` já existe e é a
   chave de admin destes endpoints.
3. **Banco** — cole `db/migracao-catalogo-bling.sql` no SQL Editor do Supabase.
   Ela apaga os produtos de teste (tudo que não veio do Bling).
4. **Autorizar** — no navegador em que o Bling está logado, abra
   `https://api.soarmacao.com.br/api/bling/auth?chave=<CRON_SECRET>` e clique
   em Autorizar. A página de retorno lista os próximos passos.
5. **Migrar as tags** (uma vez) — `…/api/bling/migrar-tags?chave=<CRON_SECRET>`.
   Cria os 4 campos customizados e preenche cada produto pai com o que estava
   nas tags no export de 27/09/2026 (`db/tags-bling.js`). Daqui em diante,
   cadastro novo no Bling preenche os **campos**, não as tags.
6. **Sincronizar** — `…/api/bling/sync?chave=<CRON_SECRET>`. Se voltar
   `concluido: false`, abra a URL em `continuar`. Confira em `/api/catalogo`.
7. **Webhooks** — no app do Bling, aba Webhooks: recursos *Produto* e
   *Estoque* apontando pra `https://api.soarmacao.com.br/api/bling/webhook`.
   A assinatura é conferida com o `client_secret`.

O cron `17 5 * * *` (02:17 em SP) refaz o sync completo todo dia e desativa o
que sumiu do Bling. `bling_sync` guarda o log de cada rodada.

### Regras que continuam no servidor

- O navegador manda `{ sku, qty }`; preço vem de `produtos`. **Sem estoque, sem
  venda** (`montarPedido` recusa quantidade acima do saldo).
- Não existe mais piso de preço nem catálogo de fallback: com o Supabase fora,
  o checkout responde 503 em vez de vender a preço velho.
- O único desconto é 30% no 2º óculos (o mais barato de cada par; não existe
  "Leve 3" nem percentual sobre o pedido inteiro). Desconto e frete são
  calculados aqui; a loja pede a cotação em `/api/cotar` e mostra o que voltou.
  Mudar a regra comercial muda a tela junto.

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

---

## Frete dinâmico (Econômico / Expresso) + pedido no Bling

Desde 28/09/2026 o frete não é mais a tabela fixa por região: o servidor cota
o CEP da cliente no **Melhor Envio** (a mesma API da calculadora do painel) e
oferece **duas opções**, sem citar transportadora — só título, prazo e preço:

- **Econômico** = a etiqueta mais barata do trecho.
- **Expresso** = entre as que chegam pelo menos `FRETE_EXPRESSO_GANHO_MIN_DIAS`
  dias antes da Econômica, a mais barata das mais rápidas.

O preço de venda de cada opção é `custo da etiqueta + margem`, arredondado pro
próximo valor terminado em **,90** (`lib/frete.js` → `precoDeVenda`). A margem
é a receita nova: quem tem pressa paga o Expresso; a Econômica já sai com uma
folga sobre o custo. Se o Melhor Envio falhar (sem token, timeout), cai na
**tabela fixa** de `lib/catalogo.js` como opção única — a loja nunca fica sem
frete.

A opção escolhida e o **serviço real por trás** (transportadora, custo cotado,
prazo) ficam gravados no pedido. Quando o pagamento confirma, o webhook cria o
**pedido de venda no Bling** (`lib/bling-pedido.js`) já com o endereço da
etiqueta, o frete cobrado e o serviço escolhido nas observações — é só gerar a
etiqueta no Bling Envios escolhendo exatamente aquele serviço. Se o Bling
falhar, o cron de reconciliação e `scripts/bling-pedido.js --pendentes` tentam
de novo.

### Novos arquivos

| Arquivo | Função |
|---|---|
| `lib/frete.js` | Cotação no Melhor Envio, regra Econômico/Expresso e a margem (arredonda pra ,90). |
| `lib/melhor-envio.js` | OAuth do Melhor Envio com refresh automático (tokens no Supabase, como o Bling). |
| `lib/bling-pedido.js` | Cria o contato + pedido de venda no Bling a partir do pedido pago. |
| `db/migracao-frete-bling.sql` | Colunas de frete/serviço e do vínculo com o Bling em `pedidos`; views `v_margem_frete` e `v_pedidos_sem_bling`. |
| `db/migracao-melhor-envio-tokens.sql` | Tabela `melhor_envio_tokens` (OAuth). |
| `scripts/melhor-envio-conectar.js` | Conecta o Melhor Envio uma vez (OAuth por loopback local). |
| `scripts/cotar-melhor-envio.js` | Cota um CEP na mão e mostra o que a loja ofereceria (valida a conexão). |
| `scripts/bling-pedido.js` | Cria/reprocessa no Bling um pedido pago (`--pendentes`, `--ver`, `--forcar`). |
| `scripts/testa-frete.js` · `testa-bling-pedido.js` | Testes offline das duas regras. |

### Autenticação do Melhor Envio (OAuth, renova sozinho)

O Melhor Envio não tem "token avulso" — é OAuth, e o token expira. Em vez de
colar um token cru (que pararia sozinho em semanas), a conexão é feita **uma
vez** e o token renova automático, igual ao Bling. Não há rota nova na Vercel
(o plano Hobby já está no teto de 12 funções): a conexão roda por um script
local, e o refresh acontece dentro do cron diário que já existe.

Passos (as chaves ficam com você — o assistente não as gera nem digita):

1. No Melhor Envio → Integrações → Área Dev → **Cadastrar aplicativo**. Marque o
   escopo de **cálculo de frete** (`shipping-calculate`) e ponha a URL de
   redirecionamento **exatamente** `http://localhost:8790/callback`. Anote o
   **Client Id** e o **Client Secret**.
2. Ponha os dois no `vercel-env.txt` (e depois na Vercel, pra produção):
   ```
   MELHOR_ENVIO_CLIENT_ID='...'
   MELHOR_ENVIO_CLIENT_SECRET='...'
   ```
3. Conecte (uma vez): `node scripts/melhor-envio-conectar.js` — ele abre a URL
   de consentimento; você autoriza no navegador logado na conta; os tokens vão
   pro Supabase. Pronto, não roda de novo.

**Variáveis (na Vercel):**

| Variável | O que é |
|---|---|
| `MELHOR_ENVIO_CLIENT_ID` / `MELHOR_ENVIO_CLIENT_SECRET` | Do app cadastrado na Área Dev. Sem eles, a loja usa a tabela fixa. |
| `MELHOR_ENVIO_REDIRECT_URI` | Opcional; padrão `http://localhost:8790/callback` (o do script de conexão). |
| `MELHOR_ENVIO_TOKEN` | Opcional: um access_token cru pra pular o OAuth num teste rápido (expira e não renova). |

**Margem e regra (têm padrão; ajuste sem mexer no código):**

| Variável | Padrão | O que faz |
|---|---|---|
| `FRETE_ECONOMICO_ADICIONAL_CENTAVOS` | `300` | Margem sobre o custo na opção Econômica (R$ 3,00). |
| `FRETE_EXPRESSO_ADICIONAL_CENTAVOS` | `1000` | Margem sobre o custo na opção Expressa (R$ 10,00). |
| `FRETE_EXPRESSO_GANHO_MIN_DIAS` | `2` | Expresso só aparece se chegar N dias antes da Econômica. |
| `FRETE_EXPRESSO_TOLERANCIA_DIAS` | `1` | Aceita até N dias a mais que a mais rápida, se sair mais barato. |
| `FRETE_DIAS_PREPARO` | `1` | Dias úteis somados ao prazo da transportadora (postagem). |
| `FRETE_TRANSPORTADORAS` | `Correios,Jadlog,Loggi,JeT` | Empresas aceitas (as com ponto de postagem simples). `*` = todas. |
| `FRETE_CEP_ORIGEM` | `09607000` | CEP de postagem. |
| `FRETE_ITEM_CM` / `FRETE_ITEM_KG` | `18x10x7` / `0.3` | Volume e peso por armação. |
| `FRETE_SEGURO_CENTAVOS` | `0` | Valor declarado no seguro (0 = sem seguro). |
| `MELHOR_ENVIO_AMBIENTE` | `production` | `sandbox` pra testar sem gastar etiqueta. |

**Bling (opcionais — melhoram o pedido, mas não são obrigatórias):**

| Variável | O que faz |
|---|---|
| `BLING_PEDIDO_AUTO` | `false` desliga a criação automática (deixa só o n8n, se você preferir). |
| `BLING_LOJA_ID` | id da "loja"/canal no Bling pra classificar o pedido. |
| `BLING_SITUACAO_PAGO_ID` | id da situação em que o pedido nasce (senão fica "Em aberto"). |
| `BLING_FORMA_PAGAMENTO_PIX_ID` / `_CARTAO_ID` | id da forma de pagamento pra lançar a parcela. |
| `BLING_PEDIDO_MAX_TENTATIVAS` | padrão 5 — quantas vezes o retry tenta antes de desistir. |

### Passo a passo pra ligar

1. Rode no SQL Editor do Supabase: `db/migracao-frete-bling.sql` **e**
   `db/migracao-melhor-envio-tokens.sql`.
2. Cadastre o app no Melhor Envio e conecte (seção "Autenticação do Melhor
   Envio" acima): Client Id/Secret no env + `node scripts/melhor-envio-conectar.js`.
3. Confira com `node scripts/cotar-melhor-envio.js 41820-021` (Salvador) e
   `... 01310-100` (SP) — dá pra ver a Econômica, a Expressa e a margem.
4. `vercel env add` do `MELHOR_ENVIO_CLIENT_ID` e `MELHOR_ENVIO_CLIENT_SECRET`
   em produção, e deploy por push na `main`.
5. Faça uma venda de teste e confira: o pedido aparece no Bling com o serviço
   certo, e `v_margem_frete` mostra cobrado − custo por opção.
