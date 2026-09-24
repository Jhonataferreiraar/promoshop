# UX Contract

## Product context

- Audience: administradores que acompanham ofertas e publicações.
- Primary jobs: manter a fila utilizável, identificar repetições e preservar uma única cópia publicável por oferta.
- Target market(s): Brasil.
- Active locales: Português do Brasil (`pt-BR`).
- Language/content register: direto, operacional e orientado à recuperação.
- Accessibility target: WCAG 2.2 AA.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Deduplicação e item canônico | `server/whatsappDedup.js` | Domínio/API | 2026-09-23 |
| Estado e publicação da fila | `server/index.js` (`/api/admin/queue`, `/api/worker/queue/next`) | Domínio/API | 2026-09-23 |
| Permissões administrativas | `server/adminPermissions.js` e autorização de `server/index.js` | Política/implementação autorizadora | 2026-09-23 |
| Retenção e ciclo de dados | `server/store.js` | Domínio/API | 2026-09-23 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`.
- Token ownership model: existing runtime CSS is canonical and follows the tokens documented in `DESIGN.md`.
- Runtime source: `src/styles.css`.
- Supported themes: claro, escuro e sistema.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table/list | `QueueTable` in `src/main.jsx` | `/api/admin/queue` | página + mostrar mais | build + fluxo no navegador |
| Toast | `.toast` with `role="status"` in `src/main.jsx` | shared admin feedback | success / error | mutation test |
| Dialog | `ConfirmationModal` | `src/ConfirmationModal.jsx` | confirmação destrutiva | teclado + recuperação |
| CRUD / soft-delete | `/api/admin/queue/duplicates` | `server/index.js` + `server/whatsappDedup.js` | marcar como ignorada | API + fluxo no navegador |

## Component behavior

| Component | Default | Hover | Focus | Active | Disabled | Busy | Error |
|---|---|---|---|---|---|---|---|
| Button | verbo explícito | contraste de fundo/borda | foco visível | mantém hierarquia | sem pointer | preserva dimensões e informa andamento | toast e estado persistido |
| Search | limpa e pesquisa a fila | realce sutil | foco visível | n/a | n/a | n/a | mensagem no painel |
| Table/list | carregamento explícito por lotes | linha destacada | foco nativo | n/a | n/a | estado estável | vazio ou erro orienta a ação |

## Dataset navigation

- Admin tables: paginação por lotes de 50 e botão “Mostrar mais publicações”.
- Duplicate summary: resumo global na primeira aba, com separação por loja.
- Empty/no-results: informar quando não há duplicatas pendentes; não tratar como erro.
- Selection scope: a limpeza abrange somente duplicatas pendentes de ofertas; itens em publicação, enviados, cupons e diretórios ficam fora.

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Limpar duplicatas | botão “Limpar duplicatas” no resumo | diálogo e botão ocupado | permanece na primeira aba | toast com quantidade marcada | toast de erro; dados permanecem intactos | foco retorna ao fluxo do painel | `server/index.js` `/api/admin/queue/duplicates` |
| Pesquisar fila | campo de pesquisa da fila | debounce existente | mesma lista, lote reiniciado | resultados e total | mensagem no painel | foco permanece no campo | `/api/admin/queue` |

## Navigation and responsive behavior

- O resumo fica na primeira aba e não mistura a ação com a tabela da fila.
- No celular, o resumo vira uma coluna; a separação por loja permanece acessível.
- A fila continua com rolagem/documento natural e carregamento explícito.

## Overlays and feedback

- Dialog primitive: `ConfirmationModal`.
- Destructive confirmation: explicar quantidade, cópia canônica e o que não será alterado.
- Toast: `.toast` com `role="status"`; erros também permanecem no fluxo de recuperação.

## Async and resilience

- Mutation: pessimista; somente após a resposta do servidor o resumo e a fila são atualizados.
- Idempotency: a operação só marca itens ainda `pending` que pertencem ao plano de duplicatas fortes.
- Failure recovery: nenhum item é alterado se a requisição falhar; o usuário pode tentar novamente.

## Permission

- A leitura respeita a permissão de visualização da fila.
- A ação de limpeza aparece e é autorizada somente para quem pode editar a fila.

## Verification

- Static: `npm run build`, `npm run test:whatsapp-dedup`.
- Browser: primeira aba em claro/escuro, celular e desktop; diálogo de confirmação; fila vazia e com duplicatas.
- Canonical sibling flow: ação “Excluir falhas” da fila, usando o mesmo diálogo, toast e recarregamento.
