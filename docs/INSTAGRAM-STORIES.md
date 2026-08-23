# Instagram Stories automático — configuração manual

O PromoShop publica pela API oficial da Meta. A senha do Instagram não é digitada nem armazenada no site.

## Antes de começar

1. No Instagram, abra o perfil da PromoShop.
2. Entre em **Configurações e atividade → Tipo e ferramentas da conta**.
3. Confirme que a conta é **Profissional do tipo Empresa (Business)**. A publicação de Stories pela API não está disponível para conta pessoal e pode não funcionar com conta Creator.
4. Deixe o perfil público.
5. Em **Editar perfil → Links**, coloque `https://promoshop.jhonatafaraujo.com.br/`. O template usa a chamada “Acesse o link da bio”.

## 1. Criar o aplicativo na Meta

1. Acesse [Meta for Developers](https://developers.facebook.com/apps/).
2. Clique em **Criar aplicativo**.
3. Quando a Meta perguntar o caso de uso, escolha a opção relacionada a **Instagram** ou **API do Instagram**. Se aparecer **Outro**, selecione-o e escolha o tipo **Empresa/Business**.
4. Nome sugerido: `PromoShop Stories`.
5. Informe o seu e-mail de contato e conclua a criação.
6. No painel do aplicativo, adicione ou configure **Instagram API with Instagram Login**. Use o fluxo com login do Instagram, não a automação do navegador.

Os nomes dos menus podem mudar um pouco. Procure sempre pelo produto **Instagram** e pela opção **API setup with Instagram login**.

## 2. Permissões necessárias

Habilite estas duas permissões no produto Instagram:

- `instagram_business_basic`
- `instagram_business_content_publish`

Não habilite permissões de mensagens, comentários ou anúncios: o PromoShop não precisa delas.

Enquanto o aplicativo estiver em modo de desenvolvimento, a Meta pode permitir somente contas adicionadas como administradoras/testadoras do app. Se aparecer **Funções do aplicativo / App roles**, adicione a conta que administra o Instagram e aceite o convite. Para liberar o uso fora das contas de teste, a Meta pode solicitar acesso avançado, revisão do aplicativo e modo **Ao vivo/Live**.

## 3. Preencher os endereços do aplicativo

Copie exatamente, sem espaços:

| Campo na Meta | Valor |
|---|---|
| Domínio do aplicativo | `jhonatafaraujo.com.br` |
| URL do site | `https://promoshop.jhonatafaraujo.com.br/` |
| URI de redirecionamento OAuth | `https://promoshop.jhonatafaraujo.com.br/api/instagram/callback` |
| URL de desautorização | `https://promoshop.jhonatafaraujo.com.br/api/instagram/deauthorize` |
| URL de solicitação de exclusão | `https://promoshop.jhonatafaraujo.com.br/api/instagram/data-deletion` |
| Instruções públicas de exclusão | `https://promoshop.jhonatafaraujo.com.br/exclusao-de-dados` |
| Política de Privacidade | `https://promoshop.jhonatafaraujo.com.br/privacidade` |
| Termos de Uso | `https://promoshop.jhonatafaraujo.com.br/termos-de-uso` |

Se a Meta oferecer dois campos de exclusão, use a rota `/api/instagram/data-deletion` no campo de callback e a página `/exclusao-de-dados` no campo de instruções.

## 4. Copiar as credenciais

1. No aplicativo da Meta, abra **Configurações do aplicativo → Básico**.
2. Copie o **ID do aplicativo**.
3. Clique em **Mostrar** na **Chave secreta do aplicativo** e copie o valor completo.
4. Não envie esses valores por WhatsApp, e-mail ou GitHub.

## 5. Conectar no PromoShop

1. Aguarde o Render terminar o deploy do GitHub.
2. Entre em `https://promoshop.jhonatafaraujo.com.br/admin`.
3. No menu **Automação**, abra **Instagram Stories**.
4. Cole o ID e a chave secreta.
5. Confirme que a URL de retorno termina em `/api/instagram/callback`.
6. Clique em **Salvar configurações do Instagram**.
7. Clique em **Conectar Instagram**.
8. Entre na conta da PromoShop e autorize as duas permissões solicitadas.
9. Ao voltar ao painel, confira o nome `@usuario` e clique em **Testar**.

O token é convertido em acesso de longa duração e renovado automaticamente perto do vencimento. O botão **Renovar acesso** permite tentar a renovação manual.

## 6. Configurar a automação

1. Deixe **Ativar Stories** desligado durante o primeiro teste de conexão.
2. Mantenha **Após o WhatsApp** ligado.
3. Defina o horário, o intervalo e o máximo diário.
4. Escolha o desconto mínimo.
5. Marque as lojas permitidas.
6. Se quiser Stories apenas de grupos específicos, marque esses grupos. Sem seleção, todos podem originar Stories.
7. Escolha **Automática pela data** para usar Natal, Black Friday, Ano-Novo e outros eventos. Abra cada tema para editar data e cores.
8. Clique em **Gerar prévia**.
9. Ative **Mostrar QR Code** se quiser um caminho direto para a oferta. A API oficial não oferece adesivo de link clicável no Story.
10. Clique em **Salvar configurações do Instagram**.
11. Ligue **Ativar Stories** e salve novamente.

## 7. Fazer o primeiro teste real

1. No PromoShop, escolha uma promoção que passe pelos filtros do Instagram.
2. Publique-a em um grupo do WhatsApp.
3. Espere o painel confirmar o envio no WhatsApp.
4. Volte a **Instagram Stories → Fila do Instagram**.
5. O produto deve aparecer como **Aguardando**.
6. Para não esperar o horário/intervalo, clique em **Publicar agora**.
7. O estado mudará para **Publicando** e depois **Publicado**.

Se falhar, o WhatsApp não será afetado. O painel tenta novamente com espera progressiva; depois de três falhas, o item fica em **Falhou** e pode ser reenviado manualmente.

## Limites e observações

- O PromoShop usa imagem JPEG pública em 1080×1920, exigência do fluxo de publicação de imagens.
- A Meta aplica limite de publicações pela API. O painel mantém o máximo diário configurável até 100 e recomenda um valor bem menor.
- Stories antigos e arquivos temporários são limpos automaticamente.
- Um reinício do Render não perde a fila e retoma publicações interrompidas.
- Não publique conteúdo enganoso, preço inventado ou imagens sem direito de uso.

## Documentação oficial

- [Instagram API — documentação oficial no workspace da Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Publicação de conteúdo do Instagram](https://www.postman.com/meta/instagram/folder/3uqmcgi/instagram-api-with-instagram-login)
