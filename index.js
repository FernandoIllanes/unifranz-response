const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const mysql = require('mysql');
const dotenv = require('dotenv');
dotenv.config();

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Connected to the database');
});

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

let sessions = {}; // Inicializamos como objeto vacío
let qrCodes = {}; // Almacenar los QR dinámicos
let socks = {};

async function startServer() {
    try {
        await loadSessionsFromDB();
        server.listen(port, async () => {
            console.log(`Servidor escuchando en http://localhost:${port}`);
            await startAllSessions();
        });
    } catch (error) {
        console.error('Error starting server:', error);
    }
}

async function loadSessionsFromDB() {
    return new Promise((resolve, reject) => {
        db.query('SELECT * FROM sessions', (err, results) => {
            if (err) {
                reject(err);
                return;
            }
            sessions = {};
            results.forEach(row => {
                sessions[row.session_id] = { user: { id: row.user_id, lid: row.user_lid } };
            });
            console.log('Sessions loaded from database');
            resolve();
        });
    });
}

function saveSessionToDB(sessionId, user) {
    const { id, lid } = user;
    db.query('REPLACE INTO sessions (session_id, user_id, user_lid) VALUES (?, ?, ?)', [sessionId, id, lid], (err) => {
        if (err) {
            console.error('Error saving session to database:', err);
        } else {
            console.log(`Session ${sessionId} saved to database`);
        }
    });
}

function deleteSessionFromDB(sessionId) {
    db.query('DELETE FROM sessions WHERE session_id = ?', [sessionId], (err) => {
        if (err) {
            console.error('Error deleting session from database:', err);
        } else {
            console.log(`Session ${sessionId} deleted from database`);
        }
    });
}

function saveSessionFilesToDB(sessionId) {
    const sessionDir = `./session_auth_info_${sessionId}`;
    const files = fs.readdirSync(sessionDir);

    files.forEach(file => {
        const filePath = `${sessionDir}/${file}`;
        const fileData = fs.readFileSync(filePath);
        db.query('REPLACE INTO session_files (session_id, file_name, file_data) VALUES (?, ?, ?)', [sessionId, file, fileData], (err) => {
            if (err) {
                console.error('Error saving session file to database:', err);
            } else {
                console.log(`File ${file} from session ${sessionId} saved to database`);
            }
        });
    });

    // Borrar archivos locales después de guardarlos en la base de datos
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

function loadSessionFilesFromDB(sessionId) {
    const sessionDir = `./session_auth_info_${sessionId}`;
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        db.query('SELECT * FROM session_files WHERE session_id = ?', [sessionId], (err, results) => {
            if (err) {
                reject(err);
                return;
            }

            results.forEach(row => {
                const filePath = `${sessionDir}/${row.file_name}`;
                fs.writeFileSync(filePath, row.file_data);
            });

            console.log(`Files for session ${sessionId} loaded from database`);
            resolve();
        });
    });
}

async function connectToWhatsApp(sessionId) {
    try {
        await loadSessionFilesFromDB(sessionId);
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
                console.log(`Conexión cerrada, reconectando con el error: ${reason}`);
                if (reason === DisconnectReason.badSession) {
                    console.log(`Bad Session File, Please Delete session_auth_info_${sessionId} and Scan Again`);
                    sock.logout();
                } else if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.connectionReplaced, DisconnectReason.loggedOut, DisconnectReason.restartRequired, DisconnectReason.timedOut].includes(reason)) {
                    await connectToWhatsApp(sessionId);
                } else {
                    console.log(`Desconexión no reconocida por razón: ${reason}`);
                }
            } else if (connection === 'open') {
                console.log(`Conexión abierta para la sesión: ${sessionId}`);
                updateQR('connected', sessionId);
                const { id, lid } = sock.user;
                sessions[sessionId] = { user: { id, lid } };
                saveSessionToDB(sessionId, { id, lid });
                io.emit('user', { sessionId, user: { id, lid } });
                saveSessionFilesToDB(sessionId);
            }
        });

        sock.ev.on('creds.update', saveCreds);
        socks[sessionId] = sock;
    } catch (error) {
        console.error('Error connecting to WhatsApp:', error);
    }
}

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
        const sock = socks[sessionId];
        if (sock) {
            await sock.logout();
            delete socks[sessionId];
        }

        delete sessions[sessionId];
        deleteSessionFromDB(sessionId);

        db.query('DELETE FROM session_files WHERE session_id = ?', [sessionId], (err) => {
            if (err) {
                console.error('Error deleting session files from database:', err);
            } else {
                console.log(`Files for session ${sessionId} deleted from database`);
            }
        });

        res.status(200).send({ message: 'Sesión eliminada exitosamente' });
    } else {
        res.status(400).send({ message: 'Sesión no encontrada' });
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
    await loadSessionsFromDB();
    for (const sessionId of Object.keys(sessions)) {
        await connectToWhatsApp(sessionId);
    }
};

async function main() {
    try {
        await startServer();
    } catch (error) {
        console.error('Error starting server:', error);
    }
}

main();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception thrown:', error);
});