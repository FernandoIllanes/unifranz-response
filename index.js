const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const qrcode = require('qrcode');
const socketIO = require('socket.io');

const app = express();
app.use(fileUpload({ createParentPath: true }));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/assets', express.static(__dirname + '/client/assets'));

const server = http.createServer(app);
const io = socketIO(server);
const port = process.env.PORT || 5000;

app.get('/scan', (req, res) => {
    res.sendFile('./client/index.html', { root: __dirname });
});

app.get('/', (req, res) => {
    res.send('server working');
});

let sock;
let qrDinamic;
let soket;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session_auth_info');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        version: [2, 2413, 1]
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        qrDinamic = qr;
        if (connection === 'close') {
            let reason = new Boom(lastDisconnect.error).output.statusCode;
            if (reason === DisconnectReason.badSession) {
                console.log(`Bad Session File, Please Delete session_auth_info and Scan Again`);
                sock.logout();
            } else if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.connectionReplaced, DisconnectReason.loggedOut, DisconnectReason.restartRequired, DisconnectReason.timedOut].includes(reason)) {
                console.log(`Connection closed, reconnecting due to reason: ${reason}`);
                connectToWhatsApp();
            } else {
                console.log(`Unknown disconnect reason: ${reason}`);
            }
        } else if (connection === 'open') {
            console.log('Connection open');
            updateQR('connected');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            console.log('Mensaje entrante recibido');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

const isConnected = () => {
    return !!sock?.user;
};

function buildMessageTemplate(template, data) {
    return template.replace(/{(\w+)}/g, (_, key) => data[key] || '');
}

app.post('/send-message', async (req, res) => {
    console.log('Hola desde el send-message');
    try {
        const reqData = req.body;
        let contactId;

        if (reqData.contact_type === 'group') {
            contactId = reqData.contact_id + '@g.us';
        } else if (reqData.contact_type === 'contact') {
            contactId = reqData.contact_id.replace(/\+/g, "") + '@s.whatsapp.net';
        }

        let messageOptions;
        if (reqData.message_type === 'static') {
            messageOptions = { text: reqData.message };
        } else if (reqData.message_type === 'customized') {
            const message = buildMessageTemplate(reqData.message_template, reqData);
            messageOptions = { text: message };
        } else {
            res.status(400).json({ status: 'error', message: 'Tipo de mensaje no válido' });
            return;
        }

        await sock.sendMessage(contactId, messageOptions);

        res.status(200).json({ status: 'success', message: 'Mensaje enviado correctamente' });
    } catch (error) {
        console.error('Error procesando la solicitud:', error);
        res.status(500).json({ status: 'error', message: 'Error procesando la solicitud' });
    }
});

io.on('connection', (socket) => {
    soket = socket;
    if (isConnected()) {
        updateQR('connected');
    } else if (qrDinamic) {
        updateQR('qr');
    }
});

const updateQR = (data) => {
    if (data === 'qr') {
        qrcode.toDataURL(qrDinamic, (err, url) => {
            soket?.emit('qr', url);
            soket?.emit('log', 'QR recibido, escanear con WhatsApp');
        });
    } else if (data === 'connected') {
        soket?.emit('qrstatus', './assets/check.svg');
        soket?.emit('log', 'Usuario conectado');
        const { id, name } = sock?.user;
        soket?.emit('user', `${id} ${name}`);
    } else if (data === 'loading') {
        soket?.emit('qrstatus', './assets/loader.gif');
        soket?.emit('log', 'Cargando...');
    }
};

connectToWhatsApp().catch((err) => console.log('Error inesperado: ' + err));
server.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});