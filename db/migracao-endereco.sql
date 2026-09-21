-- ============================================================
-- Só Armação — adiciona o endereço resolvido pelo CEP.
-- Rode no SQL Editor do Supabase. Seguro rodar mais de uma vez.
-- ============================================================

alter table pedidos add column if not exists cliente_endereco text;
alter table pedidos add column if not exists cliente_bairro   text;
alter table pedidos add column if not exists cliente_cidade   text;
alter table pedidos add column if not exists cliente_uf       text;

-- Confere o resultado:
-- select id, cliente_endereco, cliente_numero, cliente_bairro, cliente_cidade, cliente_uf
-- from pedidos order by criado_em desc limit 5;
