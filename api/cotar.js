/**
 * POST /api/cotar
 *
 * Body: { itens: [{ sku, qty }], cep?: "09760-280", frete?: "ECONOMICO" | "EXPRESSO" }
 *
 * Devolve o que o pedido custaria AGORA, calculado pela mesma regra do
 * /api/checkout (preço do banco, 30% no 2º óculos, frete). A loja usa isto pra montar
 * o carrinho e o resumo — assim a tela nunca mostra um total diferente do que
 * será cobrado, e mudar regra comercial no servidor muda a tela junto.
 *
 * Com `cep`, devolve também o endereço resolvido (ViaCEP no servidor), pra
 * loja mostrar rua/bairro/cidade sem chamar terceiros do navegador, e as
 * opções de entrega (`resumo.frete_opcoes`: Econômico / Expresso, com prazo e
 * preço) cotadas no Melhor Envio. `frete` diz qual opção entra no total; se a
 * pedida não existir pra esse CEP, o servidor volta pra ECONOMICO e informa
 * em `resumo.frete_opcao`. Sem `cep`, frete vem null (carrinho antes do endereço).
 */
import { montarPedido, resumoPublico, regrasPublicas, ValidacaoError, CatalogoIndisponivelError } from '../lib/catalogo.js';
import { consultarCep } from '../lib/cep.js';
import { aplicarCors, rateLimit, apenasMetodo } from '../lib/http.js';
import { ipDoCliente } from '../lib/validacao.js';

export default async function handler(req, res) {
  if (aplicarCors(req, res)) return;
  if (apenasMetodo(req, res, 'POST')) return;

  if (!rateLimit(`cotar:${ipDoCliente(req)}`, { max: 60, janelaMs: 60_000 })) {
    return res.status(429).json({ erro: 'Muitas consultas. Aguarde um instante.' });
  }

  try {
    const { itens, cep, frete } = req.body || {};
    const cepLimpo = String(cep || '').replace(/\D/g, '');
    const temCep = cepLimpo.length === 8;
    const [pedido, endereco] = await Promise.all([
      montarPedido(itens, cepLimpo, { semFrete: !temCep, frete }),
      temCep ? consultarCep(cepLimpo) : Promise.resolve(null),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, resumo: resumoPublico(pedido), regras: regrasPublicas(), endereco: endereco || null });
  } catch (err) {
    if (err instanceof ValidacaoError) return res.status(400).json({ erro: err.message });
    if (err instanceof CatalogoIndisponivelError) return res.status(503).json({ erro: 'Catalogo indisponivel no momento.' });
    console.error('[cotar] erro:', err);
    return res.status(500).json({ erro: 'Nao foi possivel calcular o pedido.' });
  }
}
