const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
// Raisina avy any amin'ny Variables d'environnement an'ny Render ny API KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// Initialisation Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Eto no soloina 'gemini-2.0-flash-exp' raha tianao, fa 'gemini-1.5-flash' no stable
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 

app.use(express.static(path.join(__dirname, 'public')));

// Route pour Cron-job (mba tsy hatory ny bot)
app.get('/ping', (req, res) => {
    console.log('Keep-alive ping received');
    res.send('PONG - Bot is awake');
});

// --- VARIABLES GLOBALES PAR SESSION ---
let derivWS = null;
let activeToken = null;
let isRunning = false;
let tickHistory = [];
let currentBalance = 0;
let userEmail = "";
let sessionProfit = 0;

// Settings Trading
const TRADE_CONFIG = {
    symbol: 'R_100',
    stake: 0.35,
    duration: 1,
    duration_unit: 't' // ticks
};

io.on('connection', (socket) => {
    console.log('Client connecté UI');

    socket.on('login', (token) => {
        activeToken = token;
        connectDeriv(token, socket);
    });

    socket.on('start_bot', () => {
        if (!derivWS) return;
        isRunning = true;
        logToClient(socket, "Bot START: Gemini miandry data...", "text-accent");
    });

    socket.on('stop_bot', () => {
        isRunning = false;
        logToClient(socket, "Bot STOP.", "text-muted");
    });
});

function connectDeriv(token, socket) {
    if (derivWS) derivWS.terminate();
    
    derivWS = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    derivWS.on('open', () => {
        derivWS.send(JSON.stringify({ authorize: token }));
    });

    derivWS.on('message', async (data) => {
        const msg = JSON.parse(data);

        if (msg.msg_type === 'authorize') {
            userEmail = msg.authorize.email;
            currentBalance = msg.authorize.balance;
            socket.emit('auth_success', { email: userEmail, balance: currentBalance });
            
            // Abonnement aux ticks
            derivWS.send(JSON.stringify({ ticks: TRADE_CONFIG.symbol }));
            logToClient(socket, "Mifandray amin'ny Deriv OK.", "text-success");
        }

        if (msg.msg_type === 'tick') {
            const price = msg.tick.quote;
            socket.emit('tick_update', price); // Alefa any @ UI
            
            // Tehirizo ny 30 ticks farany ho an'ny Gemini
            tickHistory.push(price);
            if (tickHistory.length > 30) tickHistory.shift();

            // Logic Bot + Gemini
            if (isRunning && tickHistory.length >= 15) {
                // Tsy miantso Gemini isaky ny tick (mavesatra loatra), fa manao interval
                // Na miandry condition pré-alable. Eto isika manao check simple.
                 analyzeAndTrade(socket);
            }
        }

        if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (contract.is_sold) {
                const profit = contract.profit;
                const isWin = profit > 0;
                sessionProfit += profit;
                
                socket.emit('trade_result', {
                    profit: profit,
                    balance: contract.balance_after,
                    totalPL: sessionProfit
                });

                const status = isWin ? "WIN" : "LOSS";
                const color = isWin ? "text-success" : "text-danger";
                logToClient(socket, `Résultat: ${status} ($${profit})`, color);
            }
        }
    });

    derivWS.on('error', (err) => {
        logToClient(socket, "Erreur WebSocket Deriv", "text-danger");
    });
}

// Variable mba tsy hifanitsaka ny analyse
let isAnalyzing = false;

async function analyzeAndTrade(socket) {
    if (isAnalyzing) return;
    isAnalyzing = true;

    try {
        // 1. Manomana ny Data ho an'ny Patron (Gemini)
        const recentPrices = tickHistory.slice(-15).join(', ');
        const prompt = `
            Act as a binary options scalper expert.
            Market: Volatility 100 Index.
            Recent prices (old to new): [${recentPrices}].
            
            Analyze the micro-trend immediately.
            If strong UP trend -> return "CALL"
            If strong DOWN trend -> return "PUT"
            If ranging/uncertain -> return "HOLD"
            
            OUTPUT ONLY ONE WORD: CALL, PUT, or HOLD.
        `;

        // 2. Mandefa any amin'ny Gemini
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().trim().toUpperCase();

        // 3. Bot Trading Execution (0.1s reaction)
        if (text === 'CALL' || text === 'PUT') {
            logToClient(socket, `GEMINI Signal: ${text}. Executing...`, "text-warning");
            placeTrade(text);
            // Miandry kely alohan'ny analyse manaraka mba tsy hanao over-trading
            await new Promise(r => setTimeout(r, 4000)); 
        } 

    } catch (error) {
        console.error("Gemini Error:", error);
    } finally {
        isAnalyzing = false;
    }
}

function placeTrade(direction) {
    if (!derivWS) return;
    
    // Convert Gemini signal to Deriv Contract Type
    const contractType = direction === 'CALL' ? 'CALL' : 'PUT';

    const tradeRequest = {
        buy: 1,
        price: TRADE_CONFIG.stake,
        parameters: {
            amount: TRADE_CONFIG.stake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            duration: TRADE_CONFIG.duration,
            duration_unit: TRADE_CONFIG.duration_unit,
            symbol: TRADE_CONFIG.symbol
        }
    };

    derivWS.send(JSON.stringify(tradeRequest));
}

function logToClient(socket, message, color) {
    socket.emit('log_message', { msg: message, color: color, time: new Date().toLocaleTimeString() });
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
