-- ============================================================
-- Só Armação — separa "subiu" de "subiu atribuído".
--
-- v_tracking_falho            → o evento NÃO chegou na plataforma. É erro.
-- v_conversao_sem_atribuicao  → o evento chegou, mas SEM identificador.
--                               A receita aparece; a origem, não.
--
-- Rode no SQL Editor do Supabase. Substitui as views existentes.
-- ============================================================

create or replace view v_tracking_falho as
select id, pago_em, total_centavos, tracking_enviado
from pedidos
where status = 'PAGO'
  and (tracking_enviado is null
       or tracking_enviado->>'meta' = 'false'
       or tracking_enviado->>'ga4'  = 'false')
order by pago_em desc;

create or replace view v_conversao_sem_atribuicao as
select
  id,
  pago_em,
  total_centavos,
  (tracking_enviado->>'identidade_meta')::boolean as meta_identificado,
  (tracking_enviado->>'identidade_ga4')::boolean  as ga4_identificado
from pedidos
where status = 'PAGO'
  and tracking_enviado->>'meta' = 'true'
  and tracking_enviado->>'ga4'  = 'true'
  and (tracking_enviado->>'identidade_meta' = 'false'
       or tracking_enviado->>'identidade_ga4' = 'false')
order by pago_em desc;

-- View ignora o RLS da tabela por padrão: sem isto a anon key lê o conteúdo.
alter view v_tracking_falho            set (security_invoker = on);
alter view v_conversao_sem_atribuicao  set (security_invoker = on);
