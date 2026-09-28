-- ============================================================
-- Só Armação — frete dinâmico (Econômico/Expresso) + pedido no Bling.
--
-- O que esta migração adiciona em `pedidos`:
--   1. A opção de entrega escolhida e o serviço real por trás dela
--      (transportadora, custo cotado, prazo) — pra gerar a etiqueta certa
--      e conferir a margem do frete depois.
--   2. O vínculo com o pedido de venda criado no Bling (id, número, erro,
--      tentativas) — pra idempotência e pro retry do cron.
--
-- Rode no SQL Editor do Supabase. É seguro rodar mais de uma vez.
-- ============================================================

-- ---- 1. entrega escolhida + serviço cotado no Melhor Envio ----
alter table pedidos add column if not exists frete_opcao          text;      -- 'ECONOMICO' | 'EXPRESSO'
alter table pedidos add column if not exists frete_origem         text;      -- 'melhor_envio' | 'tabela'
alter table pedidos add column if not exists frete_servico_id     bigint;    -- id do serviço no Melhor Envio
alter table pedidos add column if not exists frete_servico        text;      -- ex.: 'SEDEX', '.Package Centralizado'
alter table pedidos add column if not exists frete_transportadora text;      -- ex.: 'Correios', 'Jadlog'
alter table pedidos add column if not exists frete_custo_centavos integer;   -- custo real da etiqueta (o que você paga)
alter table pedidos add column if not exists frete_prazo_dias     integer;   -- prazo da transportadora (sem o dia de preparo)
alter table pedidos add column if not exists frete_prazo          text;      -- prazo exibido na loja ('até N dias úteis')
alter table pedidos add column if not exists frete_opcoes         jsonb;     -- as duas opções cotadas (snapshot)

-- ---- 2. vínculo com o Bling ----
alter table pedidos add column if not exists bling_contato_id     bigint;
alter table pedidos add column if not exists bling_pedido_id      bigint;
alter table pedidos add column if not exists bling_pedido_numero  text;
alter table pedidos add column if not exists bling_criado_em      timestamptz;
alter table pedidos add column if not exists bling_erro           text;
alter table pedidos add column if not exists bling_tentativas     integer not null default 0;

-- O cron busca "pago, sem pedido no Bling, abaixo do limite de tentativas".
create index if not exists idx_pedidos_bling_pendente
  on pedidos (status, bling_pedido_id, bling_tentativas)
  where status = 'PAGO' and bling_pedido_id is null;

-- ------------------------------------------------------------
-- Conferência da margem do frete: cobrado − custo da etiqueta, por opção.
-- (Só aparece depois que houver pedidos com estes campos preenchidos.)
-- ------------------------------------------------------------
create or replace view v_margem_frete as
select
  frete_opcao,
  count(*)                                                         as pedidos,
  round(avg(frete_centavos) / 100.0, 2)                           as cobrado_medio,
  round(avg(frete_custo_centavos) / 100.0, 2)                     as custo_medio,
  round(sum((frete_centavos - coalesce(frete_custo_centavos, 0))) / 100.0, 2) as margem_total_reais
from pedidos
where status = 'PAGO' and frete_opcao is not null
group by frete_opcao
order by frete_opcao;

alter view v_margem_frete set (security_invoker = on);

-- Pedidos pagos ainda sem etiqueta gerada no Bling (fila da expedição / alertas).
create or replace view v_pedidos_sem_bling as
select id, pago_em, total_centavos, frete_opcao, bling_tentativas, bling_erro
from pedidos
where status = 'PAGO' and bling_pedido_id is null
order by pago_em desc;

alter view v_pedidos_sem_bling set (security_invoker = on);
