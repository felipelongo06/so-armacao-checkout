-- Índice para o webhook localizar o pedido pela sessão de checkout (cartão).
create index if not exists idx_pedidos_checkout on pedidos (asaas_checkout_id);
