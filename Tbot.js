// =====================
// Importação de Dependências
// =====================
const express = require("express");
const crypto = require("crypto");

// =====================
// Configuração das Variáveis de Ambiente
// =====================
const TIMEWALL = process.env.TIMEWALL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const PORT = process.env.PORT || 3001;

// =====================
// Configuração do Bot Telegram
// =====================
let botTelegram = null;
let telegramConnected = false;

async function iniciarTelegram() {
    if (!TELEGRAM_TOKEN || !TELEGRAM_GROUP_ID) {
        console.warn("⚠️ Telegram não configurado. Configure TELEGRAM_TOKEN e TELEGRAM_GROUP_ID");
        return;
    }
    
    try {
        const { Telegraf } = require("telegraf");
        botTelegram = new Telegraf(TELEGRAM_TOKEN);
        
        // Configurar polling com parâmetros para evitar conflitos
        const pollingConfig = {
            dropPendingUpdates: true, // Ignorar atualizações pendentes
            allowedUpdates: [], // Não receber nenhuma atualização (só enviamos mensagens)
            polling: {
                timeout: 30,
                limit: 1,
                allowedUpdates: []
            }
        };
        
        // Iniciar o bot sem polling (só para enviar mensagens)
        await botTelegram.telegram.getMe(); // Testar conexão
        console.log(`🤖 Bot Telegram conectado como ${botTelegram.botInfo?.username || 'bot'}`);
        telegramConnected = true;
        
    } catch (error) {
        console.error(`❌ Erro ao conectar bot Telegram: ${error.message}`);
        if (error.response && error.response.description) {
            console.error(`📋 Detalhes: ${error.response.description}`);
        }
        
        // Tentar reconectar após 10 segundos
        setTimeout(() => {
            console.log("🔄 Tentando reconectar ao Telegram...");
            iniciarTelegram();
        }, 10000);
        
        botTelegram = null;
        telegramConnected = false;
    }
}

// ===============================
// SERVER POSTBACKS
// ===============================
const app = express();

// Middleware básico
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send(`
    <html>
      <head><title>Tbot - TimeWall Telegram</title></head>
      <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h1>🤖 Tbot - TimeWall Telegram Postback</h1>
        <p>Servidor online e funcionando!</p>
        <p>Status: <strong>${telegramConnected ? '✅ Telegram Conectado' : '⚠️ Telegram Não Conectado'}</strong></p>
        <p>Endpoint: <code>/timewall-postback</code></p>
        <p>Grupo Telegram: <code>${TELEGRAM_GROUP_ID || 'Não configurado'}</code></p>
      </body>
    </html>
  `);
});

app.get("/timewall-postback", async (req, res) => {
  console.log("🔔 TimeWall postback recebido:", req.query);
  
  // Lógica de extração de parâmetros
  const userID = req.query.userid || req.query.userID || req.query.userId;
  const revenue = req.query.revenue;
  const transactionID = req.query.transactionid || req.query.transactionID || req.query.transactionId;
  const hashRecebido = req.query.hash;
  const tipo = req.query.type;
  const currencyAmount = req.query.currencyAmount;
  
  // Validação
  if (!userID || !revenue || !transactionID || !hashRecebido || !tipo || !currencyAmount || isNaN(parseFloat(revenue)) || isNaN(parseFloat(currencyAmount))) {
    console.error("❌ TimeWall: Parâmetros em falta ou inválidos.", req.query);
    return res.status(400).send("Missing or invalid parameters");
  }

  const revenueUSD = parseFloat(revenue);
  const hashEsperada = crypto.createHash("sha256").update(userID + revenueUSD + TIMEWALL).digest("hex");
 
  if (hashRecebido !== hashEsperada) {
    console.error("⛔ TimeWall hash inválida.");
    return res.status(403).send("Invalid hash");
  }

  try {
    const usd = parseFloat(currencyAmount);
    
    // Verificar se Telegram está conectado
    if (!telegramConnected || !botTelegram) {
      console.error("❌ Telegram não está conectado. Tentando reconectar...");
      await iniciarTelegram();
      
      if (!telegramConnected) {
        return res.status(503).send("Telegram service unavailable");
      }
    }
    
    // DETECTAR PLATAFORMA PELO userID
    if (userID.startsWith('telegram_')) {
      // ✅ PROCESSAR PARA TELEGRAM
      await processarParaTelegram(userID, tipo, usd, transactionID);
      return res.status(200).send("1");
      
    } else {
      // 🔄 FALLBACK: Assumir Telegram
      console.warn(`⚠️ userID sem prefixo: ${userID}, assumindo Telegram`);
      await processarParaTelegram(`telegram_${userID}`, tipo, usd, transactionID);
      return res.status(200).send("1");
    }

  } catch (err) {
    console.error("❌ Erro crítico ao processar postback:", err);
    
    // Se erro for de conexão Telegram, tentar reconectar
    if (err.message.includes('Telegram') || err.message.includes('409')) {
      telegramConnected = false;
      console.log("🔄 Reconectando ao Telegram devido a erro...");
      setTimeout(iniciarTelegram, 5000);
    }
    
    return res.status(500).send("Internal Server Error");
  }
});

// =====================
// FUNÇÃO PARA TELEGRAM - MENSAGEM SIMPLES
// =====================
async function processarParaTelegram(userID, tipo, usd, transactionID) {
    if (!botTelegram || !TELEGRAM_GROUP_ID || !telegramConnected) {
        throw new Error("Telegram não configurado ou desconectado");
    }
    
    const userIdLimpo = userID.replace("telegram_", "");
    const tipoTarefa = (tipo === 'chargeback') ? 'CHARGEBACK' : 'CREDIT';
    
    try {
        // MENSAGEM SIMPLES - IGUAL AO DISCORD
        const mensagemTelegram = `${tipoTarefa}:${userIdLimpo}:${usd}`;
        
        // Usar método direto do Telegram API para evitar conflitos
        const response = await botTelegram.telegram.sendMessage(
            TELEGRAM_GROUP_ID,
            mensagemTelegram
        );
        
        console.log(`✅ Tarefa Telegram enviada: ${mensagemTelegram}`);
        console.log(`📨 Message ID: ${response.message_id}`);
        
        return response;
        
    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem para Telegram: ${error.message}`);
        
        // Se for erro de conflito (409), resetar conexão
        if (error.message.includes('409') || error.message.includes('Conflict')) {
            console.log("🔄 Detetado conflito, resetando conexão Telegram...");
            telegramConnected = false;
            botTelegram = null;
            
            // Tentar reconectar
            setTimeout(iniciarTelegram, 3000);
        }
        
        throw error;
    }
}

// =====================
// Início do Servidor
// =====================
async function iniciarServidor() {
    // Iniciar Telegram primeiro
    await iniciarTelegram();
    
    // Iniciar servidor HTTP
    app.listen(PORT, () => {
        console.log(`🚀 Servidor de Postbacks TimeWall/Telegram está online na porta ${PORT}`);
        console.log(`🌐 Endpoint principal: /timewall-postback`);
        console.log(`🔗 URL: http://localhost:${PORT}/timewall-postback`);
        console.log(`🌍 URL Pública: https://tbot-84o7.onrender.com`);
        
        if (telegramConnected) {
            console.log(`✅ Telegram configurado para grupo: ${TELEGRAM_GROUP_ID}`);
        } else {
            console.warn(`⚠️ Telegram não conectado. Verifique as configurações.`);
        }
    });
}

// Iniciar tudo
iniciarServidor().catch(error => {
    console.error("❌ Erro ao iniciar servidor:", error);
    process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('🛑 Desligando graciosamente...');
    if (botTelegram) {
        try {
            botTelegram.stop('SIGINT');
        } catch (e) {
            // Ignorar erros ao parar
        }
    }
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('🛑 Terminando graciosamente...');
    if (botTelegram) {
        try {
            botTelegram.stop('SIGTERM');
        } catch (e) {
            // Ignorar erros ao parar
        }
    }
    process.exit(0);
});

// Manter a aplicação viva
process.on('uncaughtException', (error) => {
    console.error('🚨 Erro não tratado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Promessa rejeitada não tratada:', reason);
});
