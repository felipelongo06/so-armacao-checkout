-- ============================================================
-- Só Armação — tokens OAuth do Melhor Envio (frete dinâmico).
--
-- Uma linha só (id = 1), como a bling_tokens. O access_token renova sozinho
-- pelo refresh_token; nada aqui é legível pela anon key.
--
-- Rode no SQL Editor do Supabase. Seguro rodar mais de uma vez.
-- ============================================================

create table if not exists melhor_envio_tokens (
  id             integer primary key default 1 check (id = 1),
  access_token   text not null,
  refresh_token  text,
  expira_em      timestamptz not null,
  escopo         text,
  atualizado_em  timestamptz not null default now()
);

alter table melhor_envio_tokens enable row level security;
-- sem policies: só a service role (backend) lê e escreve.
