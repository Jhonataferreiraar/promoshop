---
version: alpha
name: "PromoShop"
description: "Painel operacional e vitrine de ofertas com hierarquia clara, azul de ação e leitura rápida."
colors:
  primary: "#1269f3"
  primaryDark: "#0754ce"
  ink: "#101828"
  muted: "#667085"
  line: "#e4e7ec"
  soft: "#f7f8fa"
  white: "#ffffff"
  success: "#16a66a"
typography:
  sans:
    fontFamily: "Inter, Roboto, Segoe UI, Helvetica, Arial, sans-serif"
  display:
    fontFamily: "Segoe UI Variable Display, Inter, Roboto, Segoe UI, Helvetica, Arial, sans-serif"
rounded:
  sm: "12px"
  md: "18px"
  lg: "26px"
spacing:
  page-max: "1180px"
  section-gap: "24px"
components:
  button: {}
  card: {}
  dialog: {}
  table: {}
  input: {}
---

# PromoShop Design System

## Overview

### Creative North Star

PromoShop combina a energia visual de uma vitrine de ofertas com a disciplina de uma central operacional: azul elétrico para ação, superfícies brancas para leitura e etiquetas compactas para escaneamento rápido.

### Product context and register

- **Audience and primary job:** Administrador que acompanha ofertas, filas, integrações e atividades; visitante que encontra uma oportunidade e segue para a loja.
- **Target market(s) and evidence:** Brasil, com moeda, idioma e fontes de ofertas brasileiras já implementados no produto.
- **Locale(s) and language policy:** Português do Brasil; datas, números e mensagens do painel usam `pt-BR`.
- **Usage scene:** Navegador desktop para operação e celular para consulta rápida; listas precisam permanecer responsivas e legíveis.
- **Register:** Híbrido: vitrine pública expressiva e painel administrativo utilitário.
- **Memorable signature:** Azul PromoShop aplicado em chamadas, estados ativos e indicadores de operação.
- **Restraint:** Histórico, tabelas, formulários e mensagens de erro priorizam contraste e densidade previsível.
- **Anti-references:** Não parecer um painel genérico cinza nem uma página promocional que esconda estados operacionais.
- **Token ownership/runtime mapping:** Este documento registra os tokens existentes em `src/styles.css`; alterações duráveis devem atualizar o CSS na mesma mudança.

## Colors

O azul primário identifica ações e seleção. `ink` e `muted` sustentam a hierarquia textual, enquanto `line` e `soft` separam superfícies sem excesso de sombra. Estados de sucesso, atenção e erro mantêm rótulo textual além da cor. O tema escuro adapta esses papéis por variáveis em `src/styles.css` sem alterar a hierarquia.

## Typography

Inter e suas alternativas de sistema são usadas para leitura, controles e dados. A família display reforça títulos sem sacrificar fallback. Labels de painel usam caixa alta e espaçamento discreto; mensagens e valores permanecem em caixa normal para leitura rápida.

## Layout

O painel usa uma coluna lateral e uma área de conteúdo com cartões agrupados. Listas operacionais usam paginação ou carregamento explícito para evitar superfícies ilimitadas. Em telas estreitas, grades viram uma coluna e controles de filtro ocupam toda a largura.

## Elevation & Depth

Bordas e sombras suaves separam cartões. A elevação é reservada para painéis, modais e ações primárias; logs e tabelas usam linhas e tonalidade para não competir com o conteúdo.

## Shapes

Controles usam cantos de 9–12px; cartões usam 16–18px; superfícies de destaque podem usar 26px. Badges de estado são cápsulas. Divisores são finos e de baixo contraste.

## Components

### Foundational visual states

Todos os controles têm foco visível, estado desabilitado e feedback de carregamento estável. Erros aparecem em texto e orientam a recuperação; vazios explicam o próximo passo.

### Buttons and actions

Azul sólido é ação primária; contorno ou botão sutil é ação secundária; ações destrutivas ficam separadas e usam verbo explícito.

### Navigation and data display

Navegação lateral agrupa Operação, Automação e Sistema. Tabelas e históricos mostram total, filtros e estratégia de navegação. Em telas pequenas, a informação permanece acessível sem esconder ações silenciosamente.

### Forms and overlays

Campos têm labels, foco e mensagens de correção. Datas do histórico usam controles nativos `input[type=date]`, aceitos pelo produto para respeitar o calendário do sistema.

### Iconography

Ícones do componente `src/Icon.jsx` são preferidos a emojis. Ícones isolados recebem nome acessível e texto acompanha ações não óbvias.

### Motion

Movimento é curto e funcional: abertura de menus, confirmação e carregamento. Respeitar `prefers-reduced-motion`.

### Content and data visualization

O tom é direto, em português brasileiro. Registros exibem data, nível e mensagem; exportações usam CSV com cabeçalho e separador compatível com planilhas locais.

## Do's and Don'ts

- **Do:** Preserve contraste e hierarquia entre estados em claro e escuro.
- **Do:** Manter listas grandes paginadas, filtráveis e recuperáveis.
- **Don't:** Renderizar histórico ilimitado na abertura do painel.
- **Don't:** Comunicar falhas apenas pela cor ou por um ícone sem texto.
