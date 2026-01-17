const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Server } = require("socket.io");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CONFIGURATION ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Token & Keys (Render Environment Variables)
const DERIV_TOKEN = process.env.DERIV_TOKEN || "TSY_MISY_TOKEN"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TSY_MISY_KEY";

// AI SETUP (Nohavaozina ho an'ny Gemini 2.5 Flash)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// ETO NO NIOVA: Natao 'gemini-2.5-flash' araka ny sary mba ho haingana
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// VARIABLES TRADING
let ticks = [];
let isTrading = false; 
let currentStake = 0.35;
const initialStake = 0.35;
const targetProfit = 2.00; 
let totalProfit = 0;

// SERVER EXPRESS
app.use(express.static('public'));

app.get('/ping', (req, res) => {
    res.send('Pong! Bot is awake.');
    console.log("Ping received via Cron-job.");
});

// --- DERIV WEBSOCKET CONNECTION ---
const derivWS = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

derivWS.on('open', function open() {
    console.log('Mifandray amin\'ny Deriv...');
    derivWS.send(JSON.stringify({ authorize: DERIV_TOKEN }));
});

derivWS.on('message', async function incoming(data) {
    const msg = JSON.parse(data);

    if (msg.msg_type === 'authorize') {
        console.log(`Tafiditra: ${msg.authorize.email}`);
        io.emit('log', { type: 'success', message: `Bot Connecté: ${msg.authorize.email}` });
        derivWS.send(JSON.stringify({ ticks: 'R_100' }));
    }

    if (msg.msg_type === 'tick') {
        const price = msg.tick.quote;
        ticks.push(price);
        if (ticks.length > 30) ticks.shift(); 

        io.emit('price', { price: price, time: msg.tick.epoch });

        // LOGIC: Check conditions aloha vao manontany Patron
        if (!isTrading && ticks.length >= 20) {
            checkMarketAndTrade(price);
        }
    }

    if (msg.msg_type === 'proposal_open_contract') {
        const contract = msg.proposal_open_contract;
        if (contract.is_sold) {
            handleTradeResult(contract);
        }
    }
});

// --- GEMINI INTELLIGENCE (Patron 2.5 Flash) ---
async function askGeminiDecision(lastPrices) {
    try {
        const prompt = `
        Act as an expert binary options trader. 
        Here are the last 20 prices of Volatility 100 Index: [${lastPrices.join(', ')}].
        The trend is your friend. 
        Analyze the pattern immediately.
        Reply ONLY with one word: "CALL" if strong uptime, "PUT" if strong downtrend, or "WAIT" if unsure.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const decision = response.text().trim().toUpperCase();
        return decision;
    } catch (error) {
        console.error("Gemini Error:", error);
        return "WAIT";
    }
}

// --- TRADING LOGIC ---
async function checkMarketAndTrade(currentPrice) {
    const lastPrice = ticks[ticks.length - 2];
    const delta = currentPrice - lastPrice;
    
    // Sivana: Raha mihetsika be ihany vao manontany (Mitsitsy API)
    if (Math.abs(delta) > 0.05) {
        isTrading = true; 
        
        io.emit('log', { type: 'info', message: "Mihetsika ny tsena. Manontany Gemini 2.5..." });

        const decision = await askGeminiDecision(ticks);
        
        console.log(`Gemini 2.5 says: ${decision}`);
        io.emit('log', { type: 'ai', message: `Gemini Patron: ${decision}` });

        if (decision === 'CALL' || decision === 'PUT') {
            placeTrade(decision);
        } else {
            isTrading = false;
        }
    }
}

function placeTrade(direction) {
    io.emit('log', { type: 'warn', message: `Manatanteraka baiko: ${direction} @ $${currentStake}` });
    
    const tradeRequest = {
        buy: 1,
        price: currentStake,
        parameters: {
            amount: currentStake,
            basis: 'stake',
            contract_type: direction,
            currency: 'USD',
            duration: 1,
            duration_unit: 't',
            symbol: 'R_100'
        }
    };
    derivWS.send(JSON.stringify(tradeRequest));
}

function handleTradeResult(contract) {
    const profit = contract.profit;
    const isWin = profit > 0;

    totalProfit += profit;
    
    if (isWin) {
        currentStake = initialStake; 
        io.emit('log', { type: 'success', message: `WIN: +$${profit}. Total: $${totalProfit.toFixed(2)}` });
    } else {
        currentStake = (currentStake * 2.1).toFixed(2); 
        io.emit('log', { type: 'danger', message: `LOSS. Martingale -> $${currentStake}` });
    }

    isTrading = false; 
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
