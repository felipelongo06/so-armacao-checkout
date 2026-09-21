-- ============================================================
-- Só Armação — schema de pedidos (Supabase / Postgres)
-- Rode no SQL Editor do Supabase.
-- ============================================================

create table if not exists produtos (
  sku            text primary key,
  nome           text not null,
  preco_centavos integer not null check (preco_centavos >= 8990), -- piso R$ 89,90
  ativo          boolean not null default true,
  estoque        integer not null default 0,
  criado_em      timestamptz not null default now()
);

create table if not exists pedidos (
  id                    text primary key,
  status                text not null default 'AGUARDANDO_PAGAMENTO',
  metodo                text not null,

  itens                 jsonb not null,
  total_unidades        integer not null,
  subtotal_centavos     integer not null,
  desconto_pct          integer not null default 0,
  desconto_centavos     integer not null default 0,
  frete_centavos        integer not null default 0,
  total_centavos        integer not null,
  valor_pago_centavos   integer,

  cliente_nome          text not null,
  cliente_email         text not null,
  cliente_telefone      text,
  cliente_cpf_hash      text not null,   -- LGPD: nunca o CPF cru
  cliente_cep           text,
  cliente_numero        text,
  cliente_complemento   text,
  cliente_endereco      text,   -- resolvido pelo CEP no servidor
  cliente_bairro        text,
  cliente_cidade        text,
  cliente_uf            text,

  asaas_customer_id     text,
  asaas_payment_id      text,
  asaas_checkout_id     text,

  ip                    text,
  user_agent            text,
  ga_client_id          text,
  ga_session_id         text,
  fbp                   text,
  fbc                   text,
  source_url            text,

  tracking_enviado      jsonb,
  tracking_enviado_em   timestamptz,
  observacao            text,

  criado_em             timestamptz not null default now(),
  pago_em               timestamptz
);

create index if not exists idx_pedidos_status   on pedidos (status);
create index if not exists idx_pedidos_payment  on pedidos (asaas_payment_id);
create index if not exists idx_pedidos_checkout on pedidos (asaas_checkout_id);
create index if not exists idx_pedidos_email    on pedidos (cliente_email);
create index if not exists idx_pedidos_criado   on pedidos (criado_em desc);

-- Idempotência do webhook: a PK barra o reprocessamento de evento repetido.
create table if not exists webhook_eventos (
  id           text primary key,
  evento       text not null,
  payment_id   text,
  payload      jsonb,
  recebido_em  timestamptz not null default now()
);

create index if not exists idx_webhook_payment on webhook_eventos (payment_id);

-- ------------------------------------------------------------
-- RLS: nada é legível pelo cliente. Só a service role (backend) entra.
-- ------------------------------------------------------------
alter table pedidos          enable row level security;
alter table webhook_eventos  enable row level security;
alter table produtos         enable row level security;

drop policy if exists "produtos legiveis" on produtos;
create policy "produtos legiveis" on produtos for select using (ativo = true);

-- Sem policies de select/insert/update em pedidos e webhook_eventos:
-- a service role key ignora RLS, o anon key fica sem acesso. É o desejado.

-- ------------------------------------------------------------
-- Reconciliação diária: pedidos pagos no Asaas cujo webhook falhou.
-- ------------------------------------------------------------
create or replace view v_pedidos_pendentes_antigos as
select id, criado_em, total_centavos, asaas_payment_id, cliente_email
from pedidos
where status = 'AGUARDANDO_PAGAMENTO'
  and criado_em < now() - interval '2 hours'
order by criado_em desc;

-- IMPORTANTE: views em Postgres rodam com os privilégios de quem as criou,
-- ignorando o RLS das tabelas. Sem isto, a anon key consegue ler estas views
-- e enxergar e-mail de cliente. security_invoker faz a view respeitar o RLS.
alter view v_pedidos_pendentes_antigos set (security_invoker = on);

-- Conversões que não chegaram ao Meta/GA4 (auditoria de tracking).
create or replace view v_tracking_falho as
select id, pago_em, total_centavos, tracking_enviado
from pedidos
where status = 'PAGO'
  and (tracking_enviado is null
       or tracking_enviado->>'meta' = 'false'
       or tracking_enviado->>'ga4'  = 'false')
order by pago_em desc;

-- Seed do catálogo (ajuste SKUs, nomes e preços aos seus produtos reais).
insert into produtos (sku, nome, preco_centavos) values
  ('SA-D1', 'Armação D1',  8990),
  ('SA-D2', 'Armação D2',  8990),
  ('SA-D3', 'Armação D3',  9990),
  ('SA-R5', 'Armação R5', 10990),
  ('SA-V4', 'Armação V4', 12990),
  ('SA-V5', 'Armação V5', 12990)
on conflict (sku) do nothing;

alter view v_tracking_falho set (security_invoker = on);

-- Vendas que subiram mas sem identificador: receita aparece, origem não.
create or replace view v_conversao_sem_atribuicao as
select id, pago_em, total_centavos,
       (tracking_enviado->>'identidade_meta')::boolean as meta_identificado,
       (tracking_enviado->>'identidade_ga4')::boolean  as ga4_identificado
from pedidos
where status = 'PAGO'
  and tracking_enviado->>'meta' = 'true'
  and tracking_enviado->>'ga4'  = 'true'
  and (tracking_enviado->>'identidade_meta' = 'false'
       or tracking_enviado->>'identidade_ga4' = 'false')
order by pago_em desc;

alter view v_conversao_sem_atribuicao set (security_invoker = on);
