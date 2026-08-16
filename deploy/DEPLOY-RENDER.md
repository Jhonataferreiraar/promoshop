# Publicar o PromoShop no Render Starter

## Estrutura usada

- Um Web Service Starter executa o site, a API, o agendador e o publicador do WhatsApp.
- O Chromium roda sem janela aberta dentro do serviço.
- O disco persistente `/var/data` guarda configurações, credenciais criptografadas e a sessão do WhatsApp.
- A IA continua externa pela Groq.

## Criar pelo Blueprint

1. No Render, abra **New > Blueprint**.
2. Conecte o repositório privado `Jhonataferreiraar/promoshop`.
3. O Render lerá `render.yaml`.
4. Confira antes de aplicar:
   - tipo: Web Service;
   - runtime: Docker;
   - plano: Starter;
   - disco: 1 GB em `/var/data`.
5. Aplique o Blueprint e aguarde o deploy terminar.

## Primeira entrada

1. Abra a URL `onrender.com` criada pelo Render.
2. Entre no painel inicialmente com `admin` / `admin123`.
3. Troque imediatamente usuário e senha na seção de segurança do painel.
4. Cadastre novamente as credenciais do Mercado Livre, Shopee, AliExpress e Groq. Elas não são enviadas ao GitHub.
5. Em WhatsApp, clique para conectar e leia o QR Code exibido no painel.
6. Aguarde os grupos carregarem, selecione os destinos e salve.

## Domínio

Em **Settings > Custom Domains**, adicione o domínio. Depois crie no provedor de DNS exatamente os registros que o Render mostrar. O certificado HTTPS é gerado automaticamente.

## Observação sobre memória

O Starter tem 512 MB de RAM. O projeto usa limites de memória e Chromium reduzido, mas o WhatsApp pode reiniciar se ultrapassar esse limite. Se isso ocorrer repetidamente, o próximo plano indicado é uma instância com 2 GB.
