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

// =====================
// Configuração do Bot Telegram
// =====================
let botTelegram = null;
if (TELEGRAM_TOKEN && TELEGRAM_GROUP_ID) {
    try {
        const { Telegraf } = require("telegraf");
        botTelegram = new Telegraf(TELEGRAM_TOKEN);
        
        botTelegram.launch().then(() => {
            console.log(`🤖 Bot Telegram conectado como ${botTelegram.botInfo.username}`);
        }).catch(error => {
            console.error(`❌ Erro ao conectar bot Telegram: ${error.message}`);
            botTelegram = null;
        });
    } catch (error) {
        console.error("❌ Erro ao inicializar Telegram:", error.message);
        console.log("📦 Para usar Telegram, instale: npm install telegraf");
        botTelegram = null;
    }
}

// ===============================
// SERVER POSTBACKS
// ===============================
const app = express();
const PORT = 3001;

app.get("/", (req, res) => {
  res.status(200).send("Servidor de Postbacks TimeWall/Telegram está online!");
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
    return res.status(500).send("Internal Server Error");
  }
});

// =====================
// FUNÇÃO PARA TELEGRAM - MENSAGEM SIMPLES
// =====================
async function processarParaTelegram(userID, tipo, usd, transactionID) {
    if (!botTelegram || !TELEGRAM_GROUP_ID) {
        throw new Error("Telegram não configurado. Verifique TELEGRAM_TOKEN e TELEGRAM_GROUP_ID");
    }
    
    const userIdLimpo = userID.replace("telegram_", "");
    const tipoTarefa = (tipo === 'chargeback') ? 'CHARGEBACK' : 'CREDIT';
    
    try {
        // MENSAGEM SIMPLES - IGUAL AO DISCORD
        const mensagemTelegram = `${tipoTarefa}:${userIdLimpo}:${usd}`;
        
        await botTelegram.telegram.sendMessage(
            TELEGRAM_GROUP_ID,
            mensagemTelegram
        );
        
        console.log(`✅ Tarefa Telegram enviada: ${mensagemTelegram}`);
        
    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem para Telegram: ${error.message}`);
        throw error;
    }
}

// =====================
// Início do Servidor
// =====================
app.listen(PORT, () => {
    console.log(`🚀 Servidor de Postbacks TimeWall/Telegram está online na porta ${PORT}`);
    console.log(`🌐 Endpoint principal: /timewall-postback`);
    
    if (TELEGRAM_TOKEN && TELEGRAM_GROUP_ID && botTelegram) {
        console.log(`🤖 Telegram configurado para grupo: ${TELEGRAM_GROUP_ID}`);
    } else {
        console.warn(`⚠️ ATENÇÃO: Telegram não configurado!`);
        console.log(`ℹ️ Configure as variáveis: TELEGRAM_TOKEN e TELEGRAM_GROUP_ID`);
    }
});

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('🛑 Desligando graciosamente...');
    if (botTelegram) {
        botTelegram.stop('SIGINT');
    }
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('🛑 Terminando graciosamente...');
    if (botTelegram) {
        botTelegram.stop('SIGTERM');
    }
    process.exit(0);
});