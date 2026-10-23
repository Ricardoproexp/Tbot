# Tbot — TimeWall + Plisio | Northflank → Discord → Termux

Este pacote substitui a integração de pagamentos anterior pela Plisio.
O código da rota TimeWall foi preservado: mesma URL `/timewall-postback`, mesma
validação SHA-256, e mesmos formatos `CREDIT:ID:VALOR:WITHDRAWID` e
`CHARGEBACK:ID:VALOR:WITHDRAWID`. A divisão das recompensas continua no Python.

## Ficheiros para o repositório

Substituir: `README.md`, `index.js`, `package.json`, `package-lock.json`, `test_bridge.cjs`.
Adicionar obrigatoriamente: `plisio.cjs` (integração) e `test_plisio.cjs` (testes).
Também estão incluídos `Dockerfile`, `.env.example` e `.gitignore`.
Não copiar `node_modules` nem credenciais para o GitHub.

O servidor precisa de Node 24. O Dockerfile incluído configura essa versão.
Build sem Docker: `npm ci`. Arranque: `npm start`. Testes: `npm test`.
O serviço escuta no PORT definido pelo alojamento, por defeito 3001.

## O que a Plisio faz

- Recebe callbacks em `/webhooks/plisio?json=true`, valida a assinatura e
  envia ao Discord apenas `PLISIO:ID_OPERACAO:HASH_EVENTO`.
- Expõe `/plisio/rpc`, autenticado por HMAC e timestamp, para o Tbot no Termux.
- Consulta cotações, cria faturas LTC e consulta operações.
- Envia LTC para carteiras externas e guarda cada pedido antes de chamar a API.
- Um envio de resultado incerto não é repetido automaticamente. Existe reconciliação.
- Os saldos dos utilizadores são controlados pelo bot no Termux; uma mensagem
  Discord isolada não constitui prova de pagamento.

Compatível com o Tbot2.py com Plisio fornecido nesta conversa. Esta entrega contém
apenas o servidor do repositório. O Tbot2.py anterior ainda inclui funções legadas
no Python; este servidor já não as disponibiliza. Antes da troca, conclui/reconcilia
pedidos antigos e desativa o método antigo no bot. Não apagues o histórico financeiro.

## Variáveis no Northflank

O `.env.example` é um modelo; o servidor não o carrega automaticamente.
Introduz os valores no painel de variáveis do serviço.

| Variável | Valor/função |
|---|---|
| `TBOT_TOKEN` | Token Discord do emissor; `TOKEN` também é aceite |
| `TIMEWALL` | Segredo TimeWall já usado no serviço |
| `DISCORD_CHANNEL_ID` | Canal atual; por defeito `1559371192400613450` |
| `TEST_TOKEN` | Opcional, protege o endpoint de teste manual |
| `PLISIO_ENABLED` | `true` para ativar a integração |
| `PLISIO_API_KEY` | Nova chave secreta Plisio, só no servidor |
| `PLISIO_BRIDGE_SECRET` | Segredo aleatório de pelo menos 32 caracteres, igual no Termux |
| `PLISIO_PUBLIC_URL` | Domínio HTTPS público do serviço, sem caminhos |
| `PLISIO_DB_PATH` | `/data/plisio.sqlite`, num volume persistente |
| `PLISIO_PERSISTENT_STORAGE_CONFIRMED` | `yes` somente após configurar esse volume |
| `PLISIO_PAYOUTS_ENABLED` | Inicialmente `false`; `true` para permitir envios reais |
| `PLISIO_MAX_PAYOUT_LTC` | Limite por levantamento: `1` por defeito |
| `PLISIO_MAX_DEPOSIT_LTC` | Limite por fatura: `10` por defeito |

A Plisio exige IP autorizado para os pedidos de API documentados: usa o IP público
DE SAÍDA do Northflank. Não é o IP do telemóvel nem necessariamente o IP do domínio.
A disponibilidade e custo de IP fixo/volume persistente no teu plano não foram verificados.

Monta o volume em `/data` e utiliza uma única réplica. Não apagues nem restaures uma
versão antiga da base de pedidos: isso pode perder o registo de envios. Guarda backups.
O serviço recusa ativar a Plisio sem confirmação de persistência. TimeWall pode
funcionar sozinho com `PLISIO_ENABLED=false`, sem base de dados Plisio.

## Painel Plisio

Integração Custom, Litecoin ativa, marca branca desativada, comissão paga pelo Site
e pagamento a menor permitido de 0%. URL de status:

    https://TEU_DOMINIO_PUBLICO/webhooks/plisio?json=true

O código envia essa URL ao criar faturas. O endereço do painel Northflank
`app.northflank.com/.../observe/logs` não serve de callback.
A opção de retirar via API deve estar permitida para enviar pagamentos.
Não uses uma chave exposta na conversa; substitui-a e guarda-a nas variáveis.

## Termux

No ficheiro de ambiente usado pelo Tbot2.py com Plisio:

    PLISIO_ENABLED='true'
    PLISIO_BRIDGE_URL='https://TEU_DOMINIO_PUBLICO'
    PLISIO_BRIDGE_SECRET='O_MESMO_SEGREDO_ALEATORIO_DO_NORTHFLANK'
    POSTBACK_AUTHOR_IDS='ID_DISCORD_DO_BOT_EMISSOR'

Mantém os tokens Telegram/Discord e a base local. Usa `/health` para confirmar o
ID do emissor (`discord_bot_id`). Nunca coloques o token no campo de ID.
A nova integração não precisa de portas abertas no telemóvel. Todos os pedidos à
Plisio saem do Northflank; o Termux lê o Discord e consulta o servidor por HTTPS.
Mantém a hora do telemóvel sincronizada.

## Verificação e operação

`/` confirma que o HTTP responde. `/health` mostra TimeWall, Plisio e Discord;
responde 503 enquanto o Discord não estiver pronto. Não confirma, por si só, a
validade da chave Plisio nem do IP autorizado.

`npm test` usa respostas simuladas: não faz pagamentos nem envia mensagens reais.
Abrir `/test-postback` com o header `x-test-token` correto envia uma mensagem TEST
real ao Discord, sem atribuir saldo. Usa apenas quando pretenderes esse teste.

No bot: `/depositar`, menu Levantar → Plisio · Litecoin e `/plisio` para histórico
ou aprovação administrativa. `/plisio_retry` reutiliza a mesma chave; UNKNOWN e
SUBMITTING exigem análise. `/plisio_link ID_PEDIDO ID_OPERACAO` associa um pagamento
concluído após conferência administrativa, validando moeda, carteira e montante.

Antes de disponibilizar pagamentos, verifica a configuração com a tua conta e um
montante controlado. A execução real na tua conta não foi realizada nesta entrega.
