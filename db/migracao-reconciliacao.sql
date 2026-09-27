-- ============================================================
-- Só Armação — reconciliação diária de atribuição.
--
-- 1. Marca quando um pedido foi reprocessado pelo cron.
-- 2. v_cobertura_atribuicao → cobertura por dia: quantos PAGOS, quantos
--    aceitos e identificados por plataforma, e receita. É a leitura de
--    "enviado != atribuído" que o cron loga e um dashboard pode ler.
--
-- Rode no SQL Editor do Supabase. Complementa migracao-views-atribuicao.sql.
-- ============================================================

alter table pedidos
  add column if not exists tracking_reconciliado_em timestamptz;

create or replace view v_cobertura_atribuicao as
select
  date_trunc('day', pago_em)::date              as dia,
  count(*)                                       as pedidos_pagos,
  count(*) filter (where tracking_enviado->>'meta' = 'true')             as meta_ok,
  count(*) filter (where tracking_enviado->>'ga4'  = 'true')             as ga4_ok,
  count(*) filter (where tracking_enviado->>'identidade_meta' = 'true')  as meta_identificado,
  count(*) filter (where tracking_enviado->>'identidade_ga4'  = 'true')  as ga4_identificado,
  round(sum(total_centavos) / 100.0, 2)          as receita_reais
from pedidos
where status = 'PAGO'
group by 1
order by 1 desc;

-- View respeita o RLS da tabela (não vaza pela anon key).
alter view v_cobertura_atribuicao set (security_invoker = on);
