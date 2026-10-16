# RL Rewards — Render + Discord + Termux

O bot Python fica no Termux. Este servidor substitui o servidor Node do TimeWall no Render e mantém a rota `/timewall-postback`. A nova rota `/webhooks/nowpayments` recebe os callbacks da NOWPayments.

Fluxo: NOWPayments → Render (valida HMAC SHA-512) → Discord (apenas ID do payout e identificador do evento) → Termux (confirma o estado na API autenticada e atualiza SQLite/lucros.json).

## 1. Atualizar o servidor Render

Coloca `index.js`, `package.json` e `package-lock.json` na pasta do serviço Node do teu repositório. Mantém uma cópia da versão antiga antes de substituir. Este pacote não altera outros serviços, como o ffbot.

Configura o serviço como Web Service, com Node 22 ou superior:

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/`
- O servidor usa `PORT` do Render e escuta em `0.0.0.0`.

Variáveis em Render → Environment:

| Variável | Conteúdo |
|---|---|
| `TBOT_TOKEN` | Token do bot Discord que envia as mensagens; aceita `TOKEN` como alternativa |
| `TIMEWALL` | O mesmo segredo que já usas para validar o TimeWall |
| `NOWPAYMENTS_IPN_SECRET` | Uma chave IPN nova gerada na NOWPayments |
| `DISCORD_CHANNEL_ID` | Opcional; por defeito `1559371192400613450` |
| `TEST_TOKEN` | Opcional; segredo próprio para o teste manual |

Não colocar chave da API NOWPayments, palavra-passe da conta ou token Telegram no Render: o relay não precisa deles. Os ficheiros fornecidos não contêm credenciais. O segredo IPN partilhado anteriormente deve ser substituído.

Depois de publicar, abre `https://TEU-SERVICO.onrender.com/health`. Deve mostrar `discord: connected` e `nowpayments_ipn: configured`. Copia `discord_bot_id`: é um ID numérico, não o token. `/` é apenas liveness; `/health` devolve 503 se o Discord não estiver pronto.

## 2. Configurar o bot no Termux

Para o bot antes da troca. Faz backup de `bot_final.db`, da pasta `Users` e de `lucros.json`. Substitui só `Tbot1.py`, na mesma pasta da base de dados. Mantém uma única instância desse bot.

Mantém as variáveis já usadas (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, credenciais NOWPayments, etc.) e define:

```sh
export NOWPAYMENTS_IPN_MODE='discord'
export NOWPAYMENTS_IPN_URL='https://TEU-SERVICO.onrender.com/webhooks/nowpayments'
export POSTBACK_AUTHOR_IDS='ID_NUMERICO_DO_BOT_QUE_ENVIA_NO_RENDER'
```

Substitui os exemplos pelos teus valores. `POSTBACK_AUTHOR_IDS` aceita vários IDs separados por vírgulas se já existirem outros autores autorizados. Sem esta variável, o bot aceita apenas mensagens do seu próprio ID Discord. Não autorizes membros humanos do canal.

Se alterares `DISCORD_CHANNEL_ID` no Render, ajusta também a constante correspondente no Python. O bot Discord do Termux precisa de View Channel, Read Message History e Message Content Intent. O do Render precisa de View Channel e Send Messages. Usa de preferência dois bots Discord distintos para o emissor e o consumidor; autoriza o ID do emissor no Termux.

Neste modo **não precisas de abrir portas, configurar túneis nem guardar a chave IPN no Termux**. Remove variáveis IPN de uma configuração direta anterior se já não forem usadas.

O envio de levantamentos continua a precisar no Termux de:

- `NOWPAYMENTS_API_KEY`
- `NOWPAYMENTS_EMAIL`
- `NOWPAYMENTS_PASSWORD`
- `NOWPAYMENTS_RL_USD`: valor de 1 RL'$ em USD, escolhido por ti; não é presumido
- `NOWPAYMENTS_CURRENCY`: opcional, `ltc` por defeito
- `NOWPAYMENTS_CRYPTO_DECIMALS`: opcional, `8` por defeito; ajustar à moeda/rede

Ativa a opção em ADMIN → NOWPayments depois de configurar as credenciais. Cada pedido requer aprovação no bot e confirmação 2FA no dashboard NOWPayments.

## 3. URL na NOWPayments

No campo URL do webhook, coloca o endereço real:

```text
https://TEU-SERVICO.onrender.com/webhooks/nowpayments
```

É o mesmo endereço de `NOWPAYMENTS_IPN_URL` no Termux. O bot inclui-o também no pedido de criação de cada novo lote. A URL precisa de já estar publicada; este pacote não faz o deploy por ti. Lotes antigos podem manter a URL anterior e continuam a ser verificados por polling.

## 4. Garantias e limites

- Mantém o formato `CREDIT:ID:VALOR:WITHDRAWID` / `CHARGEBACK:ID:VALOR:WITHDRAWID` do TimeWall. A partilha 70/30 continua no Python; o Render não volta a aplicar percentagens.
- NOWPayments usa `NOWPAYMENTS:PAYOUT_ID:EVENT_HASH`. Endereços, montantes e segredos não são publicados nessa mensagem.
- Render responde 200 apenas depois de o Discord aceitar a mensagem. Se o envio falhar, responde 503 para permitir nova tentativa.
- As notificações repetidas são deduplicadas no SQLite. Nenhuma mensagem Discord marca um pedido como pago por si só: o estado e os dados são confirmados na API.
- Não apagues as mensagens do canal: são a fila para o Termux recuperar eventos que chegaram enquanto estava desligado. O consumidor processa eventos em tempo real e lê o histórico a cada 30 segundos.
- Sem o Termux em execução, o estado local não é atualizado até o bot voltar. A confirmação 2FA ainda pode ser necessária no dashboard NOWPayments.
- O polling da NOWPayments continua ativo como alternativa aos callbacks.
- No plano gratuito do Render, o serviço pode adormecer após 15 minutos sem tráfego e demorar a arrancar. Não garante notificações instantâneas. Ativa as novas tentativas de IPN na NOWPayments.
- O relay não depende de ficheiros persistentes no Render; a base de dados e os saldos ficam no Termux.
- Um timeout ao criar um payout não provoca reenvio automático. O callback pode recuperar a associação pelo `unique_external_id`; se isso não for possível, usa a reconciliação administrativa existente.

## Testes

`npm test` executa testes locais com Discord simulado, sem enviar mensagens reais nem pagamentos. As credenciais usadas nos testes são fictícias.

O endpoint `/test-postback`, protegido pelo header `x-test-token`, envia uma mensagem TEST ao Discord e nunca atribui saldo. Só o chames quando quiseres efetivamente enviar essa mensagem de teste.

Documentação de alojamento: https://render.com/docs/web-services e https://render.com/docs/free
