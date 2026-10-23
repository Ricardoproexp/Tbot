# Tbot 3.0 — Northflank sem volume, Discord e Termux

Esta versão elimina a exigência de /data. Mantém as rotas TimeWall e Plisio e é compatível com o Tbot3.py entregue. O servidor arranca com uma cache SQLite temporária e reconstrói o estado pelo histórico do canal Discord. Não depende de WebSockets entre Northflank e Termux.

## Instalar no serviço proexp

1. Para a instância anterior antes de iniciar esta versão. Mantém UMA réplica e evita deploys com sobreposição de instâncias. Este registo não é uma base distribuída para várias réplicas.
2. Extrai o ZIP. Substitui os ficheiros na raiz de Ricardoproexp/Tbot, branch main, incluindo index.js, plisio.cjs, config.cjs, discord-journal.cjs, package.json e package-lock.json. Não carregues apenas o ZIP fechado.
3. Mantém Node.js 24. O Dockerfile incluído configura-o. Com Buildpack, instala com npm ci e arranca com npm start; se usares um único comando, npm ci && node index.js. As dependências são instaladas no build pelo Dockerfile.
4. Mantém as cinco variáveis abaixo. Não é necessário criar volume, nem adicionar variáveis de armazenamento.
5. No canal Discord configurado, garante que o bot emissor tem View Channel, Read Message History e Send Messages. Usa o mesmo bot, canal e segredo para recuperar o histórico.
6. Faz novo build/deploy e retoma o serviço. Os logs devem mostrar HTTP ready on 3001, Recovering Plisio records from Discord history e, após a leitura, Discord ready ... recovered N records.

O serviço HTTP responde durante a recuperação; /health devolve 503 enquanto não estiver pronto. O tempo de recuperação depende do histórico e dos limites de pedidos do Discord. Configura a verificação de arranque para tolerar esse período; não reinicies repetidamente durante a leitura.

## Environment — mantém só cinco variáveis

TBOT_TOKEN=NOVO_TOKEN_DISCORD_EMISSOR
TIMEWALL=SEGREDO_TIMEWALL_ATUAL
PLISIO_API_KEY=NOVA_CHAVE_PLISIO
PLISIO_BRIDGE_SECRET=MESMO_SEGREDO_ALEATORIO_DO_TERMUX
PLISIO_PUBLIC_URL=https://rl--proexp--xhptbm9xzrwv.code.run

O segredo da ligação tem de ter pelo menos 32 caracteres. Não publiques tokens ou segredos no GitHub. O domínio acima é o mostrado nos logs fornecidos; atualiza se mudares de serviço.

PORT, canal, limites e autorização de envios estão em config.cjs. O canal atual é 1559371192400613450, a porta é 3001, o limite é 1 LTC por levantamento e 10 LTC por fatura. Para bloquear novos envios, muda payoutsEnabled para false e reinicia. As antigas variáveis PLISIO_PERSISTENT_STORAGE_CONFIRMED e PLISIO_DB_PATH não são necessárias.

## Armazenamento pelo Discord

As mensagens TPLJ1: são o registo cifrado do servidor (AES-256-GCM, chave derivada do segredo da ligação). As mensagens CREDIT/CHARGEBACK e PLISIO continuam a servir o bot no Termux. Não apagues as mensagens TPLJ1:, o canal ou a conta do bot emissor; não alteres PLISIO_BRIDGE_SECRET sem uma migração dos registos. Rodar o token do mesmo bot Discord não muda o ID; substituir o bot muda.

Antes de chamar a API de levantamentos, o servidor grava no Discord que o pedido foi iniciado. Grava também a resposta do fornecedor e os callbacks assinados. Só aplica a alteração à cache depois da escrita confirmada no Discord. Ao reiniciar, percorre o histórico completo por páginas e reconstrói os pedidos antes de aceitar operações.

Se não conseguir escrever no Discord, não inicia o pagamento. Uma resposta perdida após envio deixa a operação UNKNOWN ou SUBMITTING; nunca é reenviada automaticamente. Se a escrita no Discord ficar incerta, bloqueia novas operações até reinício e recuperação. Se faltarem partes de um registo ou o segredo estiver errado, falha a recuperação e não processa pagamentos.

A cadeia de registos deteta lacunas internas e alterações, mas não prova que ninguém apagou todo o histórico ou os últimos registos. Discord não é armazenamento ilimitado garantido nem substitui backups. Esta solução depende da conservação do canal e da utilização de uma única instância. Não apagues registos para resolver erros; faz revisão e recuperação.

Não faz migração automática de uma base /data antiga. No cenário dos logs fornecidos, o serviço não arrancava por falta desse volume. Se já houve operações financeiras numa versão anterior, conserva a base antiga e reconcilia-as antes de trocar: os avisos PLISIO antigos, sozinhos, não contêm todos os comprovativos.

## Plisio e Termux

Mantém o último Tbot3.py, bot_final.db e Users. O PLISIO_BRIDGE_SECRET do Termux tem de ser igual ao do Northflank; PLISIO_BRIDGE_URL usa o mesmo domínio público. O POSTBACK_AUTHOR_IDS contém o ID do emissor Discord.

A URL de callback é https://rl--proexp--xhptbm9xzrwv.code.run/webhooks/plisio?json=true. O código envia-a ao criar faturas. Litecoin continua a ser a moeda suportada nesta versão.

A exigência de autorizar o IP de saída na Plisio continua a aplicar-se: esta alteração resolve o armazenamento, não altera as regras da API. Não foi confirmada a disponibilidade de IP fixo no teu plano. Se a API recusar o IP, o servidor pode estar online mas os pagamentos não funcionam até resolver esse acesso.

## Testes

npm test

23 testes offline passaram, incluindo TimeWall, assinaturas, histórico paginado, mensagens divididas, reconstrução após perda da cache, confirmação sem White Label, indisponibilidade do Discord e proteção contra reenvio. Não houve chamadas reais ao Plisio ou Discord, pagamentos, alterações no GitHub nem instalação na tua conta Northflank.

Referência Discord: https://discord.com/developers/docs/resources/message (mensagens limitadas a 2000 caracteres e leitura do histórico paginada até 100 mensagens). O programa divide e cifra registos grandes, usa o disco temporário durante a recuperação e respeita o cliente Discord para os limites de pedidos.
