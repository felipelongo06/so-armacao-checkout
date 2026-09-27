-- ============================================================
-- Só Armação — catálogo sincronizado com o Bling.
--
-- O que esta migração faz:
--   1. Remove os produtos de teste/exemplo (tudo que existia antes do Bling).
--   2. Tira o piso de R$ 89,90 (o preço agora é o do Bling: custo × 7).
--   3. Acrescenta em `produtos` as colunas que o sync do Bling preenche.
--   4. Cria `bling_tokens` (OAuth) e `bling_sync` (log das sincronizações).
--
-- Rode no SQL Editor do Supabase. É seguro rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Colunas novas em produtos (uma linha = uma variação vendável)
-- ------------------------------------------------------------
alter table produtos add column if not exists bling_id            bigint;
alter table produtos add column if not exists bling_id_pai        bigint;
alter table produtos add column if not exists codigo_pai          text;
alter table produtos add column if not exists nome_variacao       text;
alter table produtos add column if not exists cor                 text;
alter table produtos add column if not exists formato             text;
alter table produtos add column if not exists genero              text;
alter table produtos add column if not exists material            text;
alter table produtos add column if not exists ocasiao             text;
alter table produtos add column if not exists tom_pele            text;
alter table produtos add column if not exists marca               text;
alter table produtos add column if not exists descricao           text;
alter table produtos add column if not exists imagem_url          text;
alter table produtos add column if not exists imagens             jsonb not null default '[]'::jsonb;
alter table produtos add column if not exists link_externo        text;
alter table produtos add column if not exists largura_lente       integer;
alter table produtos add column if not exists ponte               integer;
alter table produtos add column if not exists haste               integer;
alter table produtos add column if not exists peso_gramas         integer;
alter table produtos add column if not exists custo_centavos      integer;
alter table produtos add column if not exists ordem               integer not null default 0;
alter table produtos add column if not exists eh_teste            boolean not null default false;
alter table produtos add column if not exists bling_situacao      text;
alter table produtos add column if not exists sincronizado_em     timestamptz;
alter table produtos add column if not exists atualizado_em       timestamptz not null default now();

-- Único e SEM predicado: o upsert do sync usa `on conflict (bling_id)`.
create unique index if not exists idx_produtos_bling_id on produtos (bling_id);
create index if not exists idx_produtos_codigo_pai on produtos (codigo_pai);
create index if not exists idx_produtos_ativo_estoque on produtos (ativo, estoque);

-- ------------------------------------------------------------
-- 2. Limpa o que existia antes do Bling (seeds, exemplos e SA-TESTE).
--    Pedidos guardam os itens em jsonb, então não há FK a quebrar.
-- ------------------------------------------------------------
delete from produtos where bling_id is null;

-- ------------------------------------------------------------
-- 3. Fim do piso de R$ 89,90 — derruba qualquer CHECK sobre preco_centavos.
-- ------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'produtos'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%preco_centavos%'
  loop
    execute format('alter table produtos drop constraint %I', c.conname);
  end loop;
end $$;

alter table produtos add constraint produtos_preco_positivo check (preco_centavos > 0);

-- ------------------------------------------------------------
-- 4. Tokens OAuth do Bling (uma linha só). Nunca legível pela anon key.
-- ------------------------------------------------------------
create table if not exists bling_tokens (
  id             integer primary key default 1 check (id = 1),
  access_token   text not null,
  refresh_token  text not null,
  expira_em      timestamptz not null,
  escopo         text,
  atualizado_em  timestamptz not null default now()
);
alter table bling_tokens enable row level security;
-- sem policies: só a service role (backend) lê e escreve.

-- ------------------------------------------------------------
-- 5. Log de sincronização (pra enxergar quando o catálogo parou de atualizar)
-- ------------------------------------------------------------
create table if not exists bling_sync (
  id            bigserial primary key,
  origem        text not null,           -- 'cron' | 'manual' | 'webhook' | 'callback'
  iniciado_em   timestamptz not null default now(),
  terminado_em  timestamptz,
  ok            boolean,
  resumo        jsonb,
  erro          text
);
alter table bling_sync enable row level security;
create index if not exists idx_bling_sync_iniciado on bling_sync (iniciado_em desc);

-- ------------------------------------------------------------
-- 6. Eventos de webhook do Bling (idempotência: eventId é a PK)
-- ------------------------------------------------------------
create table if not exists bling_webhook_eventos (
  id          text primary key,
  evento      text not null,
  bling_id    bigint,
  payload     jsonb,
  recebido_em timestamptz not null default now()
);
alter table bling_webhook_eventos enable row level security;

-- ------------------------------------------------------------
-- 7. View de conferência: o que a loja vai mostrar
-- ------------------------------------------------------------
create or replace view v_catalogo_loja as
select
  codigo_pai, nome, sku, cor, formato, genero, material, ocasiao, tom_pele,
  preco_centavos / 100.0 as preco, estoque, ativo, imagem_url, link_externo,
  largura_lente, ponte, haste,
  case when largura_lente is not null and ponte is not null then largura_lente * 2 + ponte end as largura_frontal,
  sincronizado_em
from produtos
where bling_id is not null
order by codigo_pai, ordem, sku;

alter view v_catalogo_loja set (security_invoker = on);

-- Confira depois do primeiro sync:
-- select count(*) filter (where ativo) as ativos, count(*) as total, max(sincronizado_em) from produtos;
-- select * from bling_sync order by iniciado_em desc limit 5;
