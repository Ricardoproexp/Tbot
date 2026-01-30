// =====================
// Importação de Dependências
// =====================
const express = require("express");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");

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
        // Criar instância do bot sem polling
        botTelegram = new Telegraf(TELEGRAM_TOKEN, {
            telegram: { 
                apiRoot: 'https://api.telegram.org',
                agent: null,
                attachmentAgent: null
            }
        });
        
        // Usar apenas a API direta, sem polling
        await botTelegram.telegram.getMe();
        console.log(`🤖 Bot Telegram conectado como ${(await botTelegram.telegram.getMe()).username}`);
        telegramConnected = true;
        
        // NÃO INICIAR POLLING - isso causa conflitos com webhooks/postbacks
        console.log("✅ Telegram configurado apenas para envio (sem polling)");
        
    } catch (error) {
        console.error(`❌ Erro ao conectar bot Telegram:`, error.message);
        
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

// Middleware para logs
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Middleware básico
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =====================
// ENDPOINTS
// =====================

// Endpoint principal - status
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
        <p>TimeWall Secret: <code>${TIMEWALL ? 'Configurado' : 'Não configurado'}</code></p>
        <hr>
        <p><strong>Testar conexão:</strong> Acesse <code>/health</code> para verificar status completo</p>
      </body>
    </html>
  `);
});

// Health check endpoint
app.get("/health", (req, res) => {
    const health = {
        status: "online",
        timestamp: new Date().toISOString(),
        telegram: telegramConnected ? "connected" : "disconnected",
        timewall: TIMEWALL ? "configured" : "not configured",
        telegram_group: TELEGRAM_GROUP_ID || "not configured",
        server_port: PORT
    };
    res.status(200).json(health);
});

// =====================
// ENDPOINT TIMEWALL POSTBACK (PRINCIPAL)
// =====================
app.get("/timewall-postback", async (req, res) => {
  console.log("🔔 TimeWall postback recebido:", JSON.stringify(req.query));
  
  // Lógica de extração de parâmetros - IDENTICA AO CÓDIGO DO DISCORD
  const userID = req.query.userid || req.query.userID || req.query.userId;
  const revenue = req.query.revenue;
  const transactionID = req.query.transactionid || req.query.transactionID || req.query.transactionId;
  const hashRecebido = req.query.hash;
  const tipo = req.query.type;
  const currencyAmount = req.query.currencyAmount;
  
  // VALIDAÇÃO IDÊNTICA AO CÓDIGO DO DISCORD
  if (!userID) {
    console.error("❌ userID em falta");
    return res.status(400).send("Missing or invalid parameters");
  }
  
  if (!revenue || isNaN(parseFloat(revenue))) {
    console.error("❌ revenue inválido:", revenue);
    return res.status(400).send("Missing or invalid parameters");
  }
  
  if (!transactionID) {
    console.error("❌ transactionID em falta");
    return res.status(400).send("Missing or invalid parameters");
  }
  
  if (!hashRecebido) {
    console.error("❌ hash em falta");
    return res.status(400).send("Missing or invalid parameters");
  }
  
  if (!tipo) {
    console.error("❌ type em falta");
    return res.status(400).send("Missing or invalid parameters");
  }
  
  if (!currencyAmount || isNaN(parseFloat(currencyAmount))) {
    console.error("❌ currencyAmount inválido:", currencyAmount);
    return res.status(400).send("Missing or invalid parameters");
  }

  // Verificar hash - EXATAMENTE IGUAL AO DISCORD
  const revenueUSD = parseFloat(revenue);
  const hashString = userID + revenueUSD + TIMEWALL;
  const hashEsperada = crypto.createHash("sha256").update(hashString).digest("hex");
  
  console.log(`🔑 Hash calculada: ${hashEsperada}`);
  console.log(`🔑 Hash recebida: ${hashRecebido}`);
  
  if (hashRecebido !== hashEsperada) {
    console.error("⛔ TimeWall hash inválida. Esperada:", hashEsperada, "Recebida:", hashRecebido);
    return res.status(403).send("Invalid hash");
  }

  try {
    const usd = parseFloat(currencyAmount);
    
    // Verificar se Telegram está conectado
    if (!telegramConnected || !botTelegram) {
      console.error("❌ Telegram não está conectado. Tentando reconectar...");
      await iniciarTelegram();
      
      if (!telegramConnected) {
        console.error("❌ Telegram ainda não conectado após tentativa");
        return res.status(503).send("Telegram service unavailable");
      }
    }
    
    // Processar para Telegram - MENSAGEM SIMPLES COMO NO DISCORD
    const userIdLimpo = userID.replace("discord_", "").replace("telegram_", "");
    const tipoTarefa = (tipo === 'chargeback') ? 'CHARGEBACK' : 'CREDIT';
    const mensagemTelegram = `${tipoTarefa}:${userIdLimpo}:${usd}`;
    
    console.log(`📤 Enviando para Telegram: ${mensagemTelegram}`);
    
    // Usar método direto do Telegram API
    await botTelegram.telegram.sendMessage(
        TELEGRAM_GROUP_ID,
        mensagemTelegram
    );
    
    console.log(`✅ Postback processado com sucesso: ${mensagemTelegram}`);
    return res.status(200).send("1");

  } catch (err) {
    console.error("❌ Erro crítico ao processar postback:", err);
    console.error("Stack trace:", err.stack);
    
    // Se erro for de conexão Telegram
    if (err.message.includes('409') || err.message.includes('Conflict')) {
        console.log("🔄 Detetado conflito (409), resetando conexão Telegram...");
        telegramConnected = false;
        botTelegram = null;
        setTimeout(iniciarTelegram, 3000);
        return res.status(503).send("Telegram conflict, reconnecting");
    }
    
    return res.status(500).send("Internal Server Error");
  }
});

// =====================
// Endpoint de teste (apenas para debug)
// =====================
app.get("/test-postback", async (req, res) => {
    if (!telegramConnected) {
        return res.status(503).send("Telegram not connected");
    }
    
    try {
        const testMessage = `TEST:${Date.now()}:1.50`;
        await botTelegram.telegram.sendMessage(TELEGRAM_GROUP_ID, testMessage);
        res.status(200).send(`Test message sent: ${testMessage}`);
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

// =====================
// Início do Servidor
// =====================
async function iniciarServidor() {
    // Iniciar Telegram primeiro (sem polling)
    console.log("🔧 Iniciando configuração do Telegram...");
    await iniciarTelegram();
    
    // Iniciar servidor HTTP
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor de Postbacks TimeWall/Telegram está online na porta ${PORT}`);
        console.log(`🌐 Endpoint principal: /timewall-postback`);
        console.log(`🔗 URL Local: http://localhost:${PORT}`);
        console.log(`🔧 Ambiente: ${process.env.NODE_ENV || 'development'}`);
        
        if (telegramConnected) {
            console.log(`✅ Telegram conectado para grupo: ${TELEGRAM_GROUP_ID}`);
        } else {
            console.warn(`⚠️ Telegram não conectado. Postbacks não serão enviados.`);
        }
        
        if (!TIMEWALL) {
            console.error("❌ AVISO: TIMEWALL secret não configurada!");
        }
    });
}

// Iniciar tudo
iniciarServidor().catch(error => {
    console.error("❌ Erro fatal ao iniciar servidor:", error);
    process.exit(1);
});

// Graceful shutdown
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(signal => {
    process.once(signal, () => {
        console.log(`🛑 Recebido ${signal}, desligando graciosamente...`);
        if (botTelegram) {
            try {
                botTelegram.stop(signal);
            } catch (e) {
                console.log("⚠️ Erro ao parar bot Telegram:", e.message);
            }
        }
        setTimeout(() => {
            console.log("👋 Servidor terminado");
            process.exit(0);
        }, 100);
    });
});

// Manter a aplicação viva
process.on('uncaughtException', (error) => {
    console.error('🚨 Erro não tratado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Promessa rejeitada não tratada:', reason);
});

// Log de inicialização
console.log("🔄 Iniciando servidor de postbacks TimeWall para Telegram...");
