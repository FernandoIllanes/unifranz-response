const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const fs = require('fs');
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

// Cargar sesiones desde el archivo
let sessions = loadSessionsFromFile(); // Almacenar las sesiones
let qrCodes = {}; // Almacenar los QR dinámicos
let socks = {};

function loadSessionsFromFile() {
    try {
        const data = fs.readFileSync('sessions.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading sessions from file:', error);
        return {};
    }
}

function saveSessionsToFile() {
    const sessionsToSave = {};
    for (const sessionId in sessions) {
        if (sessions.hasOwnProperty(sessionId)) {
            const { user } = sessions[sessionId];
            const { id, lid } = user;
            sessionsToSave[sessionId] = { user: { id, lid } };
        }
    }
    fs.writeFileSync('sessions.json', JSON.stringify(sessionsToSave, null, 2), 'utf8');
}

const connectToWhatsApp = async (sessionId) => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(`session_auth_info_${sessionId}`);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            version: [2, 2413, 1],
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            qrCodes[sessionId] = qr;
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                console.log(`Connection closed, reconnecting due to reason: ${reason}`);
                if (reason === DisconnectReason.badSession) {
                    console.log(`Bad Session File, Please Delete session_auth_info_${sessionId} and Scan Again`);
                    sock.logout();
                } else if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.connectionReplaced, DisconnectReason.loggedOut, DisconnectReason.restartRequired, DisconnectReason.timedOut].includes(reason)) {
                    await connectToWhatsApp(sessionId);
                } else {
                    console.log(`Unknown disconnect reason: ${reason}`);
                }
            } else if (connection === 'open') {
                console.log(`Connection open for session: ${sessionId}`);
                updateQR('connected', sessionId);
                const { id, lid } = sock.user; // Extrae solo 'id' y 'lid'
                sessions[sessionId] = { user: { id, lid } };
                saveSessionsToFile();
                // Emitir evento 'user' con el ID del usuario
                io.emit('user', { sessionId, user: { id, lid } });
            }
        });

        sock.ev.on('creds.update', saveCreds);
        socks[sessionId] = sock;
    } catch (error) {
        console.error('Error connecting to WhatsApp:', error);
    }
};

const isConnected = (sessionId) => {
    return !!sessions[sessionId]?.user;
};

function buildMessageTemplate(template, data) {
    return template.replace(/{(\w+)}/g, (_, key) => data[key] || '');
}

app.post('/send-message', async (req, res) => {
    try {
        const reqData = req.body;
        const sessionId = reqData.session_id;
        let contactId;
        if (!socks[sessionId]) {
            await connectToWhatsApp(sessionId);
        }

        if (!isConnected(sessionId)) {
            res.status(400).json({ status: 'error', message: 'Sesión no conectada' });
            return;
        }

        if (reqData.contact_type === 'group') {
            contactId = reqData.contact_id + '@g.us';
        } else if (reqData.contact_type === 'contact') {
            contactId = reqData.contact_id.replace(/\+/g, '') + '@s.whatsapp.net';
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

        console.log('Mensaje enviado por: '+contactId);
        await socks[sessionId].sendMessage(contactId, messageOptions)
            .catch(error => {
                console.error('Error enviando message:', error);
                throw error;
            });
        
        res.status(200).json({ status: 'exitoso', message: 'Mensaje enviado correctamente!' });
    } catch (error) {
        console.error('Error procesando la solicitud:', error);
        res.status(500).json({ status: 'error', message: 'Error procesando la solicitud' });
    }
});

app.post('/delete-session', async (req, res) => {
    const { sessionId } = req.body;
    if (sessions[sessionId]) {
        //1. Eliminar el socket de la sesión y cerrar la conexión
        const sock = sessions[sessionId].sock;
        if (sock) {
            sock.logout();
        }

        //2. Eliminar la sesión del archivo json
        delete sessions[sessionId];
        saveSessionsToFile();

        //3. Eliminar la carpeta con la información de la sesión
        const sessionDir = `./session_auth_info_${sessionId}`;
        fs.rmSync(sessionDir, { recursive: true, force: true });

        res.status(200).send({ message: 'Session deleted successfully' });
    } else {
        res.status(400).send({ message: 'Session not found' });
    }
});

io.on('connection', (socket) => {
    // Enviar sesiones existentes al cliente
    socket.emit('sessions', Object.keys(sessions).map(sessionId => ({sessionId, user: sessions[sessionId]?.user})));

    socket.on('start-session', (sessionId) => {
        if (!sessions[sessionId]) {
            connectToWhatsApp(sessionId).catch((err) => console.log('Error inesperado: ' + err));
        }
    });

    socket.on('get-qr', (sessionId) => {
        if (qrCodes[sessionId]) {
            qrcode.toDataURL(qrCodes[sessionId], (err, url) => {
                socket.emit('qr', { sessionId, url });
                socket.emit('log', `QR recibido para la sesión ${sessionId}, escanear con WhatsApp`);
            });
        } else {
            socket.emit('log', 'Esperando a generar el QR...');
        }
    });

    socket.on('check-status', (sessionId) => {
        if (isConnected(sessionId)) {
            updateQR('connected', sessionId);
        } else if (qrCodes[sessionId]) {
            updateQR('qr', sessionId);
        }
    });
});

const updateQR = (data, sessionId) => {
    if (data === 'qr') {
        qrcode.toDataURL(qrCodes[sessionId], (err, url) => {
            io.emit('qr', { sessionId, url });
            io.emit('log', `QR recibido para la sesión ${sessionId}, escanear con WhatsApp`);
        });
    } else if (data === 'connected') {
        io.emit('qrstatus', { sessionId, status: './assets/check.svg' });
        io.emit('log', `Usuario conectado en la sesión ${sessionId}`);
        const { id } = sessions[sessionId]?.user || {};
        if (id) {
            io.emit('user', { sessionId, user: id });
        } else {
            io.emit('user', { sessionId, user: 'Unknown User' });
        }
    } else if (data === 'loading') {
        io.emit('qrstatus', { sessionId, status: './assets/loader.gif' });
        io.emit('log', `Cargando sesión ${sessionId}...`);
    }
};

const startAllSessions = async () => {
    for (const sessionId of Object.keys(sessions)) {
        await connectToWhatsApp(sessionId);
    }
};

server.listen(port, async () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    await startAllSessions();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception thrown:', error);
});