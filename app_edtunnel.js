const WebSocket = require('ws');
const { Readable } = require('stream');
const net = require('net');

// Create WebSocket server
const wss = new WebSocket.Server({ port: 443 });
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = "64.68.192." + Math.floor(Math.random() * 255);
let address = '';
let portWithRandomLog = '';

// Log function for consistent logging format
const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
};

// Listen for connection events
wss.on('connection', (ws) => {
    console.log("WebSocket connection established");
    
    // Handle incoming messages from connected WebSocket
    ws.once('message', (chunk) => {
        console.log("Received message");
        let remoteSocketWapper = { value: null };
        let isDns = false;

        const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);
        
        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

        // Handle errors in message processing
        if (handleProcessingErrors(hasError, message, ws)) return;

        // Determine if it is a DNS request
        isDns = isUDP && portRemote === 53;
        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
            return handleDNSQuery(rawClientData, ws, vlessResponseHeader, log);
        }
        handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, ws, vlessResponseHeader, log);
    });

    // Handle WebSocket close event
    ws.on('close', () => {
        console.log('Connection closed');
    });
});

// Handle outbound TCP connections
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote, remoteSocket, rawClientData, webSocket, vlessResponseHeader, log);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

// Connects to a remote server and writes the client data
async function connectAndWrite(address, port, remoteSocket, rawClientData, webSocket, vlessResponseHeader, log) {
    const options = {
        host: address,
        port: port
    };

    const tcpSocket = net.createConnection(options, () => {
        console.log('Connected to server');
    });

    remoteSocket.value = tcpSocket;
    log(`handleTCPOutBound connected to ${address}:${port}`);
    tcpSocket.write(rawClientData);

    return tcpSocket;
}

// Handles data transfer from the remote socket to the WebSocket
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
    let vlessHeader = vlessResponseHeader;

    remoteSocket.on('data', (data) => {
        if (vlessHeader) {
            new Blob([vlessHeader, data]).arrayBuffer()
                .then(arrayBuffer => {
                    webSocket.send(arrayBuffer);
                })
                .catch(error => {
                    console.error('Error handling ArrayBuffer:', error);
                });
            vlessHeader = null;
        } else {
            webSocket.send(data);
        }
    });

    // Mark stream end and handle errors
    remoteSocket.on('end', () => {
        console.log("Remote socket connection ended");
        webSocket.send(null);
    });

    remoteSocket.on('error', (error) => {
        console.error('Remote socket error:', error);
        if (retry) retry();
    });
}

// Process VLESS header to extract information
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: 'invalid data' };
    }

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;

    if (!isValidUser) {
        return { hasError: true, message: 'invalid user' };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19))[0];

    // Check command validity
    if (![1, 2].includes(command)) {
        return { hasError: true, message: `command ${command} is not supported` };
    }

    // Extract port and address details
    const portRemote = vlessBuffer.readUInt16BE(18 + optLength + 1);
    const addressType = vlessBuffer[18 + optLength + 3];
    const addressValue = extractAddress(vlessBuffer, addressType, 19 + optLength);

    return addressValue
        ? { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValue.index, vlessVersion: version, isUDP: command === 2 }
        : { hasError: true, message: `Empty address value with addressType ${addressType}` };
}

// Extracts addresses based on the address type
function extractAddress(vlessBuffer, addressType, startIndex) {
    let addressValue = '';
    let addressLength = 0;

    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = [...new Uint8Array(vlessBuffer.slice(startIndex, startIndex + addressLength))].join('.');
            break;
        case 2: // Domain name
            addressLength = new Uint8Array(vlessBuffer.slice(startIndex, startIndex + 1))[0];
            addressValue = new TextDecoder().decode(vlessBuffer.slice(startIndex + 1, startIndex + 1 + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            const ipv6 = [];
            const dataView = new DataView(vlessBuffer.slice(startIndex, startIndex + addressLength));
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            throw new Error(`Invalid addressType: ${addressType}`);
    }

    return addressValue ? { value: addressValue, length: addressLength, index: startIndex + addressLength + 1 } : null;
}

// Handle DNS queries
async function handleDNSQuery(udpChunk, webSocket, vlessResponseHeader, log) {
    const dnsServer = '8.8.4.4';
    const dnsPort = 53;

    try {
        const tcpSocket = net.createConnection({ host: dnsServer, port: dnsPort }, () => {
            console.log('Connected to DNS server');
            tcpSocket.write(udpChunk);
        });

        let vlessHeader = vlessResponseHeader;

        tcpSocket.on('data', (data) => {
            if (webSocket.readyState === WebSocket.OPEN) {
                if (vlessHeader) {
                    new Blob([vlessHeader, data]).arrayBuffer()
                        .then(arrayBuffer => {
                            webSocket.send(arrayBuffer);
                        })
                        .catch(error => {
                            console.error('Error processing ArrayBuffer:', error);
                        });
                    vlessHeader = null;
                } else {
                    webSocket.send(data);
                }
            }
        });
    } catch (error) {
        console.error(`handleDNSQuery exception: ${error.message}`);
    }
}

// Error handling for message processing
function handleProcessingErrors(hasError, message, ws) {
    if (hasError) {
        console.log('Error occurred, connection closed: ' + message);
        ws.close();
        return true;
    }
    return false;
}

/**
 * Safety close the WebSocket connection
 * @param {WebSocket} socket
 */
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('Error closing WebSocket safely:', error);
    }
}

// Helper functions for converting data types
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] +
            byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] +
            "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] +
            byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
            byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] +
            byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    return unsafeStringify(arr, offset);
}
