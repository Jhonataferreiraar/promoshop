# PromoShop

Projeto de afiliados com site público, painel administrativo, coleta de ofertas e publicador local para grupos do WhatsApp.

## Componentes

- **Site e painel:** React + Vite.
- **API e agendador:** Node.js + Express.
- **Dados iniciais:** arquivo JSON local, com camada isolada para futura migração ao Azure Storage.
- **WhatsApp:** processo local com `whatsapp-web.js` e sessão persistente.

## Executar localmente

No Windows, depois da primeira instalação, você pode simplesmente dar dois cliques em `INICIAR-SITE.cmd`. Não abra o `index.html` diretamente, pois aplicações React precisam do servidor local e a página ficará em branco.

1. Execute `npm install` na primeira vez.
2. Dê dois cliques em `INICIAR-SITE.cmd` ou execute `npm start`.
3. Abra `http://localhost:3001`.
4. O painel fica em `http://localhost:3001/admin`.

O primeiro acesso é `admin` / `admin123`. Entre em **Segurança** e troque esses dados antes de publicar.

Todas as configurações comuns ficam no painel:

- **Fontes de ofertas:** token do Mercado Livre, feed autorizado da Shopee, buscas, desconto mínimo e intervalo.
- **WhatsApp:** conexão, escolha entre os grupos encontrados, link público, limites, pausas, horários e mensagem.
- **Aparência do site:** nome, textos, cor e aviso de afiliado.
- **Segurança:** usuário e senha do painel.

Tokens e senhas são criptografados nos arquivos locais de dados e não aparecem novamente no painel.

## Publicador do WhatsApp

1. Abra **Painel → WhatsApp**.
2. Clique em **Conectar WhatsApp**.
3. Leia no próprio painel o QR Code usando **WhatsApp → Aparelhos conectados**.
4. Aguarde o painel carregar os grupos da conta.
5. Escolha o grupo na lista e clique em **Salvar grupo e regras**.

A sessão fica salva em `.wwebjs_auth`. O publicador respeita horário silencioso, limites diário e por hora configurados no painel.

> O WhatsApp pode suspender contas que usem automação não autorizada. Use um número secundário e apenas em grupo próprio com participantes que aceitaram receber promoções.

## Links de afiliado

Ofertas coletadas do Mercado Livre entram como `pending-link` porque o link público do produto não deve ser presumido como link com comissão. Converta ou confirme o link nas ferramentas oficiais do programa antes de ativar/publicar. Ofertas manuais exigem o link afiliado.

A Shopee fica desativada até que um feed autorizado da conta seja configurado no painel.

## Configuração avançada

O arquivo `.env` é opcional. Ele serve apenas para substituir configurações em ambientes de servidor ou implantação avançada. No uso local normal, faça tudo pelo painel.

## Produção

Para manter o site, o agendador e o WhatsApp ligados continuamente, publique o projeto inteiro em uma máquina virtual Linux. Os arquivos prontos para Azure VM estão em `deploy/DEPLOY-AZURE.md`.

- Com IA externa, uma VM com 2 vCPU e 4 GB de memória é o ponto de partida recomendado.
- O processo principal inicia e recupera o publicador do WhatsApp automaticamente quando essa opção estiver ligada no painel.
- `data/`, `.wwebjs_auth/` e `.env` são persistentes e nunca devem ser enviados ao GitHub.
- A chave da IA e as credenciais das plataformas são guardadas no cofre criptografado local.
