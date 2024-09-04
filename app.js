const net = require('net');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');

const logcb = (...args) => console.log(...args);
const errcb = (...args) => console.error(...args);

const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, "");
const port = process.env.PORT || 3000;

const wss = new WebSocket.Server({ port }, logcb('listen:', port));

wss.on('connection', ws => {
    console.log("on connection");

    ws.once('message', msg => {
        const [VERSION] = msg;
        const id = msg.slice(1, 17);

        if (!id.every((value, index) => value === parseInt(uuid.substr(index * 2, 2), 16))) return;

        let index = msg.slice(17, 18).readUInt8() + 19;
        const remotePort = msg.slice(index, index += 2).readUInt16BE(0);
        const ATYP = msg.slice(index, index += 1).readUInt8();

        const host = 
            ATYP === 1 ? msg.slice(index, index += 4).join('.') : // IPV4
            ATYP === 2 ? new TextDecoder().decode(msg.slice(index + 1, index += 1 + msg.slice(index, index + 1).readUInt8())) : // domain
            ATYP === 3 ? msg.slice(index, index += 16).reduce((acc, byte, i, arr) =>
                (i % 2 ? acc.concat(arr.slice(i - 1, i + 1)) : acc), []).map(byte => byte.readUInt16BE(0).toString(16)).join(':') : 
            ''; // IPV6

        logcb('conn:', host, remotePort);
        ws.send(new Uint8Array([VERSION, 0]));

        const duplex = createWebSocketStream(ws);
        net.connect({ host, port: remotePort }, function () {
            this.write(msg.slice(index));
            duplex.on('error', errcb('E1:')).pipe(this).on('error', errcb('E2:')).pipe(duplex);
        }).on('error', errcb('Conn-Err:', { host, remotePort }));
    }).on('error', errcb('EE:'));
});
