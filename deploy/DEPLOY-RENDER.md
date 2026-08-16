# Publicar o PromoShop no Render Starter

## Estrutura usada

- Um Web Service Starter executa o site, a API, o agendador e o publicador do WhatsApp.
- O Chromium roda sem janela aberta dentro do serviço.
- O disco persistente `/var/data` guarda configurações, credenciais criptografadas e a sessão do WhatsApp.
- A IA continua externa pelo Gemini, Groq ou outro provedor escolhido no painel.

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
2. Em **Environment**, crie `ADMIN_PASSWORD` com uma senha exclusiva de pelo menos 12 caracteres e faça um novo deploy.
3. Entre com o usuário `admin` e a senha definida nessa variável.
4. Salve uma nova senha na seção **Segurança**; ela passará a ser protegida no disco persistente e as sessões anteriores serão encerradas.
5. Cadastre as credenciais do Mercado Livre, Shopee, AliExpress e da IA. Elas não são enviadas ao GitHub.
6. Em WhatsApp, clique para conectar e leia o QR Code exibido no painel.
7. Aguarde os grupos carregarem, selecione os destinos e salve.

## Domínio

Em **Settings > Custom Domains**, adicione o domínio. Depois crie no provedor de DNS exatamente os registros que o Render mostrar. O certificado HTTPS é gerado automaticamente.

## Observação sobre memória

O Starter tem 512 MB de RAM. O projeto usa limites de memória e Chromium reduzido, mas o WhatsApp pode reiniciar se ultrapassar esse limite. Se isso ocorrer repetidamente, o próximo plano indicado é uma instância com 2 GB.
