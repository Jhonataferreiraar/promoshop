# PromoShop — Lote Mercado Livre

Esta é uma **segunda extensão**, independente da extensão individual em [`../extension-mercadolivre/`](../extension-mercadolivre/). A extensão antiga continua disponível e não é alterada.

A versão em lote lê os produtos visíveis em uma página de busca, categoria ou ofertas do Mercado Livre. Para cada item selecionado, ela abre a página individual, aciona a Barra de Afiliados oficial, captura o link `meli.la` e envia os produtos confirmados ao PromoShop.

## Instalação

1. Abra `chrome://extensions` (ou `edge://extensions`) e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione esta pasta `extension-mercadolivre-lote`.
3. No painel PromoShop, abra **Extensão Mercado Livre** e gere o token da extensão.
4. Abra o ícone **PromoShop — Lote Mercado Livre**, informe a URL do painel e cole o token.
5. No Mercado Livre, mantenha a Barra de Afiliados ativada e abra uma página de resultados.
6. Clique em **Ler página**, marque os produtos e depois em **Capturar lote**.

## Como funciona

- O lote pode ter 5, 10, 20, 40 ou todos os produtos encontrados na página (até 40 itens por leitura).
- A extensão processa os produtos um por vez, com intervalo padrão de 10 segundos entre páginas, para reduzir bloqueios temporários do Mercado Livre.
- Cada produto é validado novamente na página individual. Itens sem desconto válido, sem imagem ou sem link oficial são informados como falha e não entram no catálogo.
- Os produtos confirmados são enviados em grupos de até 10, limite aceito pelo endpoint do PromoShop.
- O processamento continua mesmo se o popup for fechado. Ao abri-lo novamente, o último progresso fica disponível.
- **Cancelar** encerra o próximo item com segurança e preserva os produtos que já foram enviados.

## Requisitos e privacidade

- É necessário estar conectado ao Mercado Livre e ter a Barra de Afiliados oficial disponível.
- A extensão não lê nem envia cookies, senhas ou dados privados da conta.
- Ela somente aciona a interface pública/visível da Barra de Afiliados, lê o link `meli.la` gerado para o produto e envia ao PromoShop os dados públicos da oferta.
- Não use a versão em lote em páginas que você não autorizou a processar. O navegador pode abrir e fechar várias abas durante a captura.

Se a Barra de Afiliados não gerar um link para algum produto, o item será listado como falha para que você possa tentar novamente individualmente com [`../extension-mercadolivre/`](../extension-mercadolivre/).
