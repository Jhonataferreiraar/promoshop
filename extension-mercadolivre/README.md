# PromoShop — Ofertas Mercado Livre

Extensão dedicada à captura de uma promoção individual do Mercado Livre com o link gerado pela Barra de Afiliados oficial.

## Instalação

1. Abra `chrome://extensions`, ative o modo do desenvolvedor e use **Carregar sem compactação** nesta pasta.
2. Gere um token na aba **Extensão de cupons** do painel PromoShop e salve-o no popup.
3. Ative a Barra de Afiliados nas configurações do Mercado Livre.
4. Abra uma página individual de produto em promoção e clique em **Gerar link e capturar oferta**.

Se a extensão já estava instalada, abra `chrome://extensions` e clique em **Recarregar** depois de atualizar esta pasta. A versão 0.1.1 reconhece também páginas de catálogo, URLs com `wid`, endereços `MLBU` e páginas individuais identificadas pela estrutura do produto.

A extensão não lê nem envia cookies, senhas ou dados da conta. Ela apenas aciona a interface oficial visível, lê o link `meli.la` gerado e envia os dados públicos da oferta ao PromoShop.
