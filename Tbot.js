
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const crypto = require("crypto");

// Configuração do Tbot (separado do ffbot)
const TOKEN = process.env.TBOT_TOKEN || process.env.TOKEN;
const TIMEWALL = process.env.TIMEWALL;
const PORT = process.env.PORT || 3001;
const CANAL_ID = "1559371192400613450";

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
const app = express();

app.get("/", (req, res) => {
    res.status(200).send("Tbot - Servidor TimeWall/Discord online!");
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        discord: client.isReady() ? "connected" : "disconnected",
        timewall: TIMEWALL ? "configured" : "not configured",
        discord_channel: CANAL_ID,
        server_port: PORT
    });
});

// Enviar mensagem para o canal de processamento
async function enviarDiscord(mensagem) {
    const canal = await client.channels.fetch(CANAL_ID);
    if (!canal || !canal.isTextBased() || typeof canal.send !== "function") {
        throw new Error("Canal Discord indisponível");
    }
    await canal.send({ content: mensagem, allowedMentions: { parse: [] } });
}

// Postback TimeWall: validações e formato de mensagem do Tbot
app.get("/timewall-postback", async (req, res) => {
    const userID = req.query.userid || req.query.userID || req.query.userId;
    const revenue = req.query.revenue;
    const transactionID = req.query.transactionid || req.query.transactionID || req.query.transactionId;
    const hash = req.query.hash;
    const tipo = req.query.type;
    const currencyAmount = req.query.currencyAmount;
    const withdrawid = req.query.withdrawid;

    const textoValido = (v) => typeof v === "string" && v.length > 0;
    if (![userID, transactionID, hash, tipo, withdrawid].every(textoValido) ||
        !textoValido(revenue) || !Number.isFinite(parseFloat(revenue)) ||
        !textoValido(currencyAmount) || !Number.isFinite(parseFloat(currencyAmount))) {
        console.error("❌ Parâmetros TimeWall inválidos");
        return res.status(400).send("Missing or invalid parameters");
    }
    if (!TIMEWALL) return res.status(503).send("TimeWall not configured");

    // Mesmo cálculo SHA-256 do Tbot original
    const esperado = crypto.createHash("sha256")
        .update(userID + parseFloat(revenue) + TIMEWALL).digest();
    const recebido = /^[a-f0-9]{64}$/i.test(hash) ? Buffer.from(hash, "hex") : null;
    if (!recebido || !crypto.timingSafeEqual(recebido, esperado)) {
        console.error("⛔ Hash TimeWall inválida");
        return res.status(403).send("Invalid hash");
    }

    const userIdLimpo = userID.replace("Telegram_", "");
    const tipoTarefa = tipo === "chargeback" ? "CHARGEBACK" : "CREDIT";
    const mensagem = `${tipoTarefa}:${userIdLimpo}:${parseFloat(currencyAmount)}:${withdrawid}`;

    try {
        if (!client.isReady()) return res.status(503).send("Discord unavailable");
        await enviarDiscord(mensagem);
        console.log(`✅ Postback enviado: ${mensagem}`);
        return res.status(200).send("1");
    } catch (erro) {
        console.error("❌ Erro ao enviar para Discord:", erro);
        return res.status(500).send("Internal Server Error");
    }
});

// Teste manual protegido por TEST_TOKEN
app.get("/test-postback", async (req, res) => {
    if (!process.env.TEST_TOKEN || req.get("x-test-token") !== process.env.TEST_TOKEN) {
        return res.status(403).send("Forbidden");
    }
    if (!client.isReady()) return res.status(503).send("Discord unavailable");
    try {
        const mensagem = `TEST:${Date.now()}:1.50`;
        await enviarDiscord(mensagem);
        return res.status(200).send(`Test message sent: ${mensagem}`);
    } catch (erro) {
        console.error("❌ Erro no teste:", erro);
        return res.status(500).send("Internal Server Error");
    }
});

// Iniciar como no ffbot: servidor HTTP quando o Discord estiver pronto
client.once("ready", () => {
    console.log(`✅ Tbot conectado como ${client.user.tag}`);
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Tbot online na porta ${PORT}`);
        console.log(`📢 Canal Discord: ${CANAL_ID}`);
    });
});

client.on("error", (erro) => console.error("❌ Discord:", erro));

if (!TOKEN || !TIMEWALL) {
    console.error("❌ Configure TBOT_TOKEN e TIMEWALL");
    process.exit(1);
}
client.login(TOKEN).catch((erro) => {
    console.error("❌ Falha no login do Discord:", erro);
    process.exit(1);
});
