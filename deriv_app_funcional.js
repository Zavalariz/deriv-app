const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = 3000; 

// *************************************************************
// CORRECCIÓN CLAVE: APP ID 116785 de 'Trader Solidario Dev'
// *************************************************************
const APP_ID = 116785; 
const WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;

// Variables de estado globales
let currentAccountId = null;
let currentAuthToken = null; 
let ws = null; // Conexión WebSocket
let contractResult = null; // Almacena el resultado final para /api/result

app.use(express.json());

// 1. SERVIR EL FRONTEND (index.html)
app.get('/', (req, res) => {
    // Asegura que el archivo index.html se sirva desde la misma carpeta
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. ENDPOINT PARA AUTENTICACIÓN INICIAL (/api/connect)
app.post('/api/connect', (req, res) => {
    const authToken = req.body.apiToken;

    if (!authToken) {
        return res.status(400).json({ status: 'error', message: 'Token API no proporcionado.' });
    }

    // Cierra la conexión WS anterior si existe para empezar limpia
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    contractResult = null;
    currentAuthToken = authToken; 

    // Inicia una nueva conexión WS para la autenticación
    startWebSocketAuth(authToken, res);
});

// 3. ENDPOINT PARA INICIAR LA OPERACIÓN (/api/trade)
app.post('/api/trade', (req, res) => {
    const { amount, duration, contractType } = req.body;

    if (!currentAuthToken) {
        return res.status(401).json({ status: 'error', message: 'No hay sesión activa. Conéctese primero.' });
    }
    if (!amount || !duration || !contractType) {
        return res.status(400).json({ status: 'error', message: 'Faltan parámetros de operación.' });
    }
    
    // Inicia una nueva conexión WS para la operación de trading
    startWebSocketTrade(amount, duration, contractType, res);
});


// 4. ENDPOINT PARA OBTENER EL RESULTADO DEL CONTRATO
app.get('/api/result', (req, res) => {
    // Devuelve el resultado si está disponible, o null si aún no termina
    res.json({ result: contractResult });
});


// 5. LÓGICA WS - SOLO PARA AUTENTICACIÓN INICIAL
function startWebSocketAuth(authToken, httpResponse) {
    let httpResponseSent = false;
    ws = new WebSocket(WS_URL);

    ws.on('open', function open() {
        ws.send(JSON.stringify({ authorize: authToken }));
        console.log('[BACKEND] 🔑 Enviando solicitud de autenticación...');
    });

    ws.on('message', function incoming(data) {
        const response = JSON.parse(data);

        if (response.error) {
            if (!httpResponseSent) {
                httpResponse.status(500).json({ status: 'error', message: response.error.message });
                httpResponseSent = true;
            }
            ws.close();
            return;
        }

        if (response.msg_type === 'authorize') {
            const authData = response.authorize;
            currentAccountId = authData.loginid;
            
            if (!httpResponseSent) {
                // Envía la respuesta HTTP al frontend para indicar conexión exitosa
                httpResponse.json({
                    status: 'success',
                    message: `Autenticación exitosa con ${currentAccountId}.`,
                    account_id: currentAccountId,
                    balance: parseFloat(authData.balance)
                });
                httpResponseSent = true;
            }
            // Cierra la conexión de autenticación
            ws.close(); 
        } 
    });

    ws.on('error', function error(err) { 
        console.error('[BACKEND] ⚠️ Error WS en Auth:', err.message); 
        if (!httpResponseSent) {
             httpResponse.status(500).json({ status: 'error', message: 'Error de conexión WebSocket en Auth.' });
             httpResponseSent = true;
        }
    });
    ws.on('close', function close() { console.log('[BACKEND] 🛑 Conexión de Auth cerrada.'); });
}


// 6. LÓGICA WS - PARA LA OPERACIÓN DE TRADING
function startWebSocketTrade(amount, duration, contractType, httpResponse) {
    ws = new WebSocket(WS_URL);
    let tradeHttpResponseSent = false;
    contractResult = null; // Limpia el resultado anterior para el nuevo trade

    ws.on('open', function open() {
        ws.send(JSON.stringify({ authorize: currentAuthToken }));
        console.log('[BACKEND] 🔑 Re-autenticando para el Trade...');
    });

    ws.on('message', function incoming(data) {
        const response = JSON.parse(data);

        if (response.error) {
            if (!tradeHttpResponseSent) {
                httpResponse.status(500).json({ status: 'error', message: response.error.message });
                tradeHttpResponseSent = true;
            }
            ws.close();
            return;
        }

        if (response.msg_type === 'authorize') {
            // Una vez autorizado, envía las solicitudes de trading
            sendTradeRequests(ws, amount, duration, contractType);
            if (!tradeHttpResponseSent) {
                // Envía la respuesta HTTP al frontend para iniciar el polling
                httpResponse.json({ status: 'success', message: 'Trade iniciado.' });
                tradeHttpResponseSent = true;
            }
        } 
        
        else if (response.msg_type === 'buy') {
            if (response.error) {
                 console.error(`[BACKEND] ❌ Error en Compra: ${response.error.message}`);
                 if (!tradeHttpResponseSent) {
                    httpResponse.status(400).json({ status: 'error', message: response.error.message });
                    tradeHttpResponseSent = true;
                 }
            } else {
                console.log(`[BACKEND] 🎉 Compra Exitosa. ID Contrato: ${response.buy.contract_id}. Esperando resultado...`);
                // Suscribe al contrato abierto para monitorear el resultado
                ws.send(JSON.stringify({
                    "proposal_open_contract": 1,
                    "contract_id": response.buy.contract_id,
                    "subscribe": 1
                }));
            }
        }

        else if (response.msg_type === 'proposal_open_contract') {
            const contract = response.proposal_open_contract;
            
            // Revisa si el contrato ha sido vendido (terminado)
            if (contract.is_sold === 1) {
                const profit = contract.sell_price - contract.buy_price; 
                const resultado = profit >= 0 ? 'GANANCIA' : 'PÉRDIDA';
                
                // Almacena el resultado para ser consultado por /api/result
                contractResult = `🎯 RESULTADO FINAL:\n\n---\nCuenta: ${currentAccountId}\nTipo: ${contractType}\nMonto: $${contract.buy_price.toFixed(2)}\nResultado: ${resultado}\nGanancia/Pérdida Neta: ${profit.toFixed(2)} USD`;

                console.log(`[BACKEND] --- RESULTADO: ${resultado} / $${profit.toFixed(2)} ---`);
                
                // Limpia suscripciones y cierra el WS
                ws.send(JSON.stringify({ "forget_all": "ticks" }));
                ws.send(JSON.stringify({ "forget": contract.id }));
                ws.close();
            }
        }
    });
    
    ws.on('error', function error(err) { 
        console.error('[BACKEND] ⚠️ Error WS en Trade:', err.message); 
        if (!tradeHttpResponseSent) {
             httpResponse.status(500).json({ status: 'error', message: 'Error de conexión WebSocket en Trade.' });
             tradeHttpResponseSent = true;
        }
    });
    ws.on('close', function close() { console.log('[BACKEND] 🛑 Conexión de Trade cerrada.'); });
}

// 7. FUNCIÓN DE SOLICITUD DE TRADING DINÁMICA
function sendTradeRequests(ws, amount, duration, contractType) {
    // Suscribe a los ticks del símbolo (Volatilidad 100)
    ws.send(JSON.stringify({ "ticks": "R_100", "subscribe": 1 }));
    console.log(`[BACKEND] ➡️ Solicitando ticks para ${contractType}.`);
    
    // Envía la solicitud de compra a la API de Deriv
    const buyRequest = JSON.stringify({
        "buy": 1, 
        "price": amount, // <-- Precio de compra (stake)
        "parameters": {
            "amount": amount, 
            "basis": "stake", 
            "contract_type": contractType, 
            "currency": "USD", 
            "duration": duration, 
            "duration_unit": "t", 
            "symbol": "R_100"         
        }
    });
    ws.send(buyRequest);
    console.log(`[BACKEND] 🛒 Intentando ${contractType} de $${amount} por ${duration} ticks.`);
}

// 8. INICIAR EL SERVIDOR WEB
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 SERVIDOR WEB INICIADO: Escuchando en el puerto ${PORT}`);
    console.log(`======================================================`);
});