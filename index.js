const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const port = 3001;

const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: "remote",
        remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Cliente listo!');

    /* client.getChats().then(chats => {
        const groups = chats.filter(chat => chat.isGroup);
        groups.forEach(group => {
            console.log(`Grupo: ${group.name} - ID: ${group.id._serialized}`);
        });
    }).catch(err => {
        console.error('Error listando los grupos:', err);
    }); */

    setInterval(async () => {
        try {
            const info = await client.info;
            const phoneNumber = info.me.user;
            await client.sendMessage(`${phoneNumber}@c.us`, "Ping para mantener la sesión activa (solo para pruebas)");
            console.log("Ping enviado");
        } catch (error) {
            console.error("Error al enviar el ping:", error);
        }
    }, 12 * 60 * 60 * 1000);
});

client.on('auth_failure', (msg) => {
    console.error('Fallo al autenticar', msg);
});

client.initialize();

// Función para realizar el reemplazo de variables
function buildMessageTemplate(template, values) {
    return template.replace(/{([^{}]*)}/g, (match, key) => {
        return values[key] || match;
    });
}

const server = http.createServer((req, res) => {
    if (req.url === '/send-message') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const reqData = JSON.parse(body);
                let contactId;

                if (reqData.contact_type === 'group') {
                    // es un grupo
                    contactId = reqData.contact_id + '@g.us';
                } else if (reqData.contact_type === 'contact') {
                    // es un contacto
                    contactId = reqData.contact_id.replace(/\+/g, "") + '@c.us';
                }

                if (reqData.message_type === 'static') {
                    await client.sendMessage(contactId, reqData.message);
                } else if (reqData.message_type === 'customized') {
                    const message = buildMessageTemplate(reqData.message_template, reqData);
                    await client.sendMessage(contactId, message);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', message: 'Tipo de mensaje no valido' }));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: 'Mensaje enviado correctamente' }));
            } catch (error) {
                console.error('Error procesando la solicitud:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: 'Error procesando la solicitud' }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'URL no encontrada' }));
    }
});

server.listen(port, () => {
    console.log('Servidor escuchando en http://localhost:3001');
});
