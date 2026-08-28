# PostgreSQL do PromoShop no Render

O PromoShop continua usando o arquivo `db.json` enquanto `STORE_BACKEND=file` ou a variável não existir. O PostgreSQL só é ativado explicitamente.

## Antes de ativar

1. Publique a versão do PromoShop que contém o suporte ao PostgreSQL.
2. Confirme que o site, o painel e o WhatsApp continuam funcionando com o banco atual.
3. Verifique se `DATA_ENCRYPTION_KEY` já existe no Environment. Se existir, não a altere. Se não existir, no Shell do serviço copie o conteúdo de `/var/data/.data-key` e salve-o como variável secreta `DATA_ENCRYPTION_KEY`. Não gere outra chave: ela precisa ser exatamente a chave já usada pelos dados atuais.
4. Não remova o disco persistente. A sessão do WhatsApp continua dependendo dele.

## Criar o banco

1. No Dashboard do Render, escolha **New +** e depois **Postgres**.
2. Use o nome `promoshop-postgres` e o banco `promoshop`.
3. Escolha a mesma região do serviço web do PromoShop.
4. Para produção, escolha um plano pago e o menor armazenamento adequado.
5. Aguarde o banco ficar disponível.

## Conectar e migrar

No serviço web do PromoShop, abra **Environment** e adicione:

- `DATABASE_URL`: use a **Internal Database URL** do banco.
- `STORE_BACKEND`: `postgres`.
- `PG_POOL_MAX`: `5`.
- `DATA_ENCRYPTION_KEY`: a chave atual copiada de `/var/data/.data-key`.

Salve as variáveis. No primeiro início com o PostgreSQL ativo, o PromoShop cria sua estrutura e importa o `db.json` somente se o banco estiver vazio. O arquivo antigo não é apagado.

## Conferência

1. Abra `/api/health` e confirme `storage.backend` igual a `postgres` e `storage.connected` igual a `true`.
2. Confira no painel as quantidades de ofertas, cupons, fila e publicações enviadas.
3. Confira configurações, grupos, Feed e Stories.
4. Aguarde uma publicação de teste no WhatsApp antes de considerar a migração concluída.

## Retorno de emergência

Se a primeira inicialização falhar antes de qualquer alteração nova no PostgreSQL, altere `STORE_BACKEND` para `file` e faça novo deploy. O arquivo original continuará no disco. Depois que o PostgreSQL receber dados novos, não volte ao arquivo sem antes exportar ou sincronizar esses dados, pois o arquivo preservado representa o momento da migração.
