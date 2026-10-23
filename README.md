# Northflank — TimeWall + Plisio, configuração mínima

Esta versão substitui o ZIP anterior. Mantém o TimeWall e corrige a confirmação sem White Label. É compatível com o último Tbot2.py Plisio fornecido: não é necessário alterar o Python para esta correção, porque o servidor devolve o mesmo formato validado que o bot já utiliza.

## Instalar

1. Faz backup das bases existentes. Substitui no repositório os ficheiros deste ZIP e adiciona `config.cjs` e `plisio.cjs`. Usa o Dockerfile incluído (Node.js 24), ou Node 24 com `npm ci` e `npm start`.
2. Configura UMA réplica e um volume persistente montado em `/data`. Se já existe `/data/plisio.sqlite`, preserva-o e os ficheiros SQLite auxiliares. Não restaures uma versão antiga: o registo impede reenvios.
3. Expõe a porta HTTP 3001 e obtém o domínio HTTPS público do serviço.
4. Introduz as cinco variáveis abaixo e reinicia o serviço.
5. Autoriza no Plisio o IP público de saída do serviço e permite retiradas pela API. Confirma o custo/disponibilidade do volume e do IP de saída na tua conta; este pacote não garante alojamento gratuito.

O arranque verifica se `/data` é um ponto de montagem e recusa guardar os pagamentos na camada descartável do contentor. A verificação não consegue provar a durabilidade do armazenamento: seleciona um volume persistente no Northflank, não um volume temporário.

## Environment — só cinco variáveis

| Key | Value |
|---|---|
| TBOT_TOKEN | Novo token do bot Discord emissor do Northflank, não Telegram |
| TIMEWALL | Segredo TimeWall atual |
| PLISIO_API_KEY | Nova chave secreta Plisio |
| PLISIO_BRIDGE_SECRET | Segredo aleatório com pelo menos 32 caracteres, igual ao Termux |
| PLISIO_PUBLIC_URL | Domínio HTTPS público real do serviço, sem caminho |

Substitui os tokens/chaves expostos na conversa. Não os coloques no GitHub. Não uses o endereço do painel app.northflank.com como domínio público. A URL pública permanece em environment porque depende do domínio efetivamente atribuído ao teu serviço; não é uma chave secreta.

Remove as antigas variáveis NOWPAYMENTS. PORT, DISCORD_CHANNEL_ID, PLISIO_ENABLED, PLISIO_DB_PATH, PLISIO_PERSISTENT_STORAGE_CONFIRMED, PLISIO_PAYOUTS_ENABLED, PLISIO_MAX_PAYOUT_LTC e PLISIO_MAX_DEPOSIT_LTC já não são necessárias: a configuração de produção é construída por `config.cjs`. Variáveis antigas com esses nomes não alteram os valores do ficheiro.

## Valores públicos em config.cjs

- Porta: 3001.
- Canal Discord: 1559371192400613450.
- Base: /data/plisio.sqlite.
- Limite por levantamento: 1 LTC.
- Limite por depósito: 10 LTC.
- `payoutsEnabled: true`: permite o envio quando o administrador o confirma no bot. Para suspender novos envios, muda para false e faz novo deploy; consultas continuam disponíveis.

O endpoint manual /test-postback fica desativado em produção. /health mostra a ligação Discord e o ID do bot emissor; não comprova o funcionamento financeiro.

## Termux e Plisio

Mantém o último Tbot2.py, os seus tokens, `bot_final.db` e `Users`. No `termux.env`, define `PLISIO_ENABLED=true`, `PLISIO_BRIDGE_URL` com o mesmo domínio público, `PLISIO_BRIDGE_SECRET` igual ao servidor e `POSTBACK_AUTHOR_IDS` com o ID Discord do emissor.

No painel Plisio: Litecoin ativa, comissão paga pelo Site, tolerância de pagamento a menor em 0%, White Label não necessário para este fluxo. A URL de status é:

https://TEU_DOMINIO_PUBLICO/webhooks/plisio?json=true

O servidor também envia este callback_url ao criar cada fatura. Depósitos são criptomoeda LTC, não depósitos bancários em euros. A cotação e o valor da unidade de saldo continuam configurados no bot.

## O que mudou

Depósitos: callbacks JSON são autenticados com HMAC-SHA1 e guardados antes do aviso Discord. Quando a consulta da operação omite moeda/montante, o servidor usa o callback assinado concluído, com ID e número de pedido correspondentes. Consulta ainda o estado atual pela API. Apenas uma conclusão válida permite ao bot creditar o saldo uma vez. Mensagens Discord nunca constituem prova de pagamento.

Levantamentos: a resposta original do envio é guardada de forma persistente. Quando a consulta posterior omite moeda/montante/endereço, esses campos vêm da resposta original validada contra o pedido. O estado vem da consulta atual. Campos presentes mas contraditórios são rejeitados. Nenhum campo financeiro é inventado a partir do pedido do utilizador.

Se faltarem o callback do depósito ou os dados da resposta original do levantamento, a operação permanece pendente para revisão. Isto também se aplica a operações antigas cujo comprovativo não ficou guardado. Não existe crédito automático só por um ID/status. Pagamentos a mais com estado mismatch exigem revisão manual.

Um envio com resultado UNKNOWN ou SUBMITTING não é reenviado automaticamente. Uma reconciliação exige prova de endereço, moeda e montante; se a API os omitir e a resposta original tiver sido perdida, a reconciliação automática continua bloqueada. Confere a operação no fornecedor; não cries outro pagamento nem devolvas o saldo sem apurar o resultado.

## Validação

`npm test`: 17 testes offline passaram, incluindo callbacks adulterados, respostas sem campos White Label, preservação após reinício, dados contraditórios e proteção contra reenvio. Os sete testes financeiros Python do bot compatível também passaram.

Não foram usados tokens reais nem realizadas transferências, publicação no GitHub ou implantação no Northflank. A compatibilidade foi testada com respostas simuladas baseadas na documentação fornecida; falta validação com a tua conta e infraestrutura.
