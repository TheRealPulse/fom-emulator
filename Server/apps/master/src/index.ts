/**
 * FoM Server Emulator V2
 *
 * Uses native RakNet 3.611 via Bun FFI for proper reliability, ACKs, and duplicate detection.
 *
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    RakPeer,
    RakReliability,
    RakPriority,
    type RakPacket,
    type RakSystemAddress,
    addressToIp,
    addressToString,
    PacketLogger,
    PacketDirection,
    LithPacketRead,
    NativeBitStream,
    readU32c,
} from '@openfom/networking';
import { RakNetMessageId } from '@openfom/packets';

import { configureLogger, debug as logDebug, error as logError, info as logInfo, warn as logWarn } from '@openfom/utils';
import { loadRuntimeConfig } from './config';
import { ConnectionManager } from './network/Connection';
import { LoginHandler } from './handlers/LoginHandler';
import { createPacketHandlers } from './handlers/registerHandlers';
import { loadRsaKeyFromJson, type RsaKeyJson } from './utils/Rsa';
import rsaKeyJson from './fom_private_key.json' with { type: 'json' };

const runtime = loadRuntimeConfig();
const config = runtime.server;
const packetLogConfig = runtime.packetLog;

const {
    quiet,
    consoleMode,
    consoleMinIntervalMs,
    logToFile,
    analysisEnabled,
    consolePacketIds,
    filePacketIds,
    ignorePacketIds,
    consoleRepeatSuppressMs,
    flushMode,
} = packetLogConfig;

configureLogger({ quiet, debug: config.debug || config.loginDebug });

PacketLogger.installConsoleMirror({ echoToConsole: !quiet });

const packetLogger = new PacketLogger({
    console: !quiet && consoleMode !== 'off',
    file: logToFile,
    consoleMode,
    consoleMinIntervalMs,
    consolePacketIds,
    filePacketIds,
    ignorePacketIds,
    analysis: analysisEnabled,
    consoleRepeatSuppressMs,
    flushMode,
    assumePayload: true,
});

PacketLogger.setGlobal(packetLogger);
PacketLogger.setConsoleMirrorEcho(!quiet);

// =============================================================================
// Server Setup
// =============================================================================

// =============================================================================
// Load RSA Keys
// =============================================================================

const rsaKey = loadRsaKeyFromJson(rsaKeyJson as RsaKeyJson);
if (rsaKey) {
    logInfo(`[RSA] Loaded private key: ${rsaKey.modulusBytes} bytes, ${rsaKey.endian} endian`);
} else {
    logWarn('[RSA] Failed to load private key - login decryption will fail');
}

logInfo('='.repeat(60));
logInfo(' FoM Server Emulator V2 - Native RakNet');
logInfo('='.repeat(60));
logInfo(`  Mode: ${config.serverMode}`);
logInfo(`  Port: ${config.port}`);
logInfo(`  Max Connections: ${config.maxConnections}`);
logInfo(`  RSA Key: ${rsaKey ? 'loaded' : 'NOT LOADED'}`);
logInfo(`  Debug: ${config.debug}`);
logInfo(`  LoginStrict: ${config.loginStrict}`);
logInfo(`  LoginClientVersion: ${config.loginClientVersion}`);
logInfo('='.repeat(60));
logInfo('');

// Create components
const peer = new RakPeer();
const connections = new ConnectionManager();
const loginHandler = new LoginHandler({
    serverMode: config.serverMode,
    worldIp: config.worldIp,
    worldPort: config.worldPort,
    debug: config.debug,
    loginDebug: config.loginDebug,
    loginStrict: config.loginStrict,
    loginRequireCredentials: config.loginRequireCredentials,
    acceptLoginAuthWithoutUser: config.acceptLoginAuthWithoutUser,
    resendDuplicateLogin6D: config.resendDuplicateLogin6D,
    loginClientVersion: config.loginClientVersion,
    loginResetDelayMs: config.loginResetDelayMs,
    worldSelectWorldId: config.worldSelectWorldId,
    worldSelectWorldInst: config.worldSelectWorldInst,
    worldSelectPlayerId: config.worldSelectPlayerId,
    worldSelectPlayerIdRandom: config.worldSelectPlayerIdRandom,
});

// Start the server
if (!peer.startup(config.maxConnections, config.port, 0)) {
    logError('[Server] Failed to start RakNet peer');
    process.exit(1);
}

peer.setMaxIncomingConnections(config.maxConnections);
peer.setIncomingPassword(config.password);

logInfo(`[Server] Listening on port ${config.port}`);
logInfo('');

// =============================================================================
// Send Helper
// =============================================================================

function sendReliable(data: Buffer, address: RakSystemAddress): boolean {
    // Log outbound packet before send to keep file log complete.
    const addrIp = addressToIp(address);
    const connection = connections.get(address);
    const outgoingPacket = {
        timestamp: new Date(),
        direction: PacketDirection.OUTGOING,
        address: addrIp,
        port: address.port,
        data,
        connectionId: connection?.id,
    };
    try {
        const logged = packetLogger.log(outgoingPacket);
        packetLogger.logAnalysis(outgoingPacket, logged);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        PacketLogger.globalNote(
            `[Error] packetLog SEND addr=${addrIp}:${address.port} len=${data.length} err=${msg}`,
        );
    }

    const success = peer.send(
        data,
        RakPriority.HIGH,
        RakReliability.RELIABLE,  // Changed from RELIABLE_ORDERED - FoM expects RELIABLE
        0, // ordering channel
        address,
        false, // not broadcast
    );
    if (config.debug) {
        const addr = addressToString(address);
        const msgId = data[0];
        logDebug(
            `[Server] SEND 0x${msgId.toString(16).padStart(2, '0')} to ${addr} (${data.length} bytes) - ${success ? 'OK' : 'FAIL'}`,
        );
    }
    return success;
}

function sendUnreliable(data: Buffer, address: RakSystemAddress): boolean {
    // Log outbound packet before send to keep file log complete.
    const addrIp = addressToIp(address);
    const connection = connections.get(address);
    const outgoingPacket = {
        timestamp: new Date(),
        direction: PacketDirection.OUTGOING,
        address: addrIp,
        port: address.port,
        data,
        connectionId: connection?.id,
    };
    try {
        const logged = packetLogger.log(outgoingPacket);
        packetLogger.logAnalysis(outgoingPacket, logged);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        PacketLogger.globalNote(
            `[Error] packetLog SEND addr=${addrIp}:${address.port} len=${data.length} err=${msg}`,
        );
    }

    const success = peer.send(
        data,
        RakPriority.LOW,
        RakReliability.UNRELIABLE,
        0,
        address,
        false,
    );
    if (config.debug) {
        const addr = addressToString(address);
        const msgId = data[0];
        logDebug(
            `[Server] SEND (UNREL) 0x${msgId.toString(16).padStart(2, '0')} to ${addr} (${data.length} bytes) - ${success ? 'OK' : 'FAIL'}`,
        );
    }
    return success;
}

// =============================================================================
// Packet Handlers
// =============================================================================

const handlers = createPacketHandlers({
    connections,
    loginHandler,
    sendReliable,
});

type HuffmanEntry = { sym: number; bitlen: number; bits: string };
type HuffmanNode = { zero?: HuffmanNode; one?: HuffmanNode; sym?: number };

// Runtime Huffman table is dumped by the client hook; use it for chat decoding.
const huffmanRoot: HuffmanNode | null = (() => {
    try {
        const tablePath = path.resolve(process.cwd(), 'huffman_table_runtime.json');
        const raw = fs.readFileSync(tablePath, 'utf8');
        const entries = JSON.parse(raw) as HuffmanEntry[];
        const root: HuffmanNode = {};
        for (const entry of entries) {
            let node = root;
            for (const bit of entry.bits) {
                if (bit === '0') {
                    node.zero ??= {};
                    node = node.zero;
                } else {
                    node.one ??= {};
                    node = node.one;
                }
            }
            node.sym = entry.sym;
        }
        return root;
    } catch (error) {
        logDebug(`[Server] Huffman table load failed: ${(error as Error).message}`);
        return null;
    }
})();

// Decode null-terminated Huffman strings (MSB order).
function decodeHuffmanMsb(payload: Buffer, startBit: number): { text: string; endBit: number } | null {
    if (!huffmanRoot) return null;
    const totalBits = payload.length * 8;
    let node: HuffmanNode | undefined = huffmanRoot;
    let bit = startBit;
    const bytes: number[] = [];
    while (bit < totalBits) {
        const byte = payload[bit >> 3] ?? 0;
        const bitVal = (byte >> (7 - (bit & 7))) & 1;
        node = bitVal ? node?.one : node?.zero;
        if (!node) {
            break;
        }
        bit += 1;
        if (node.sym !== undefined) {
            if (node.sym === 0) {
                break;
            }
            bytes.push(node.sym & 0xff);
            if (bytes.length >= 2048) {
                break;
            }
            node = huffmanRoot;
        }
    }
    const text = Buffer.from(bytes).toString('latin1');
    return text ? { text, endBit: bit } : null;
}

// Decode null-terminated Huffman strings (LSB order).
function decodeHuffmanLsb(payload: Buffer, startBit: number): { text: string; endBit: number } | null {
    if (!huffmanRoot) return null;
    const totalBits = payload.length * 8;
    let node: HuffmanNode | undefined = huffmanRoot;
    let bit = startBit;
    const bytes: number[] = [];
    while (bit < totalBits) {
        const byte = payload[bit >> 3] ?? 0;
        const bitVal = (byte >> (bit & 7)) & 1;
        node = bitVal ? node?.one : node?.zero;
        if (!node) {
            break;
        }
        bit += 1;
        if (node.sym !== undefined) {
            if (node.sym === 0) {
                break;
            }
            bytes.push(node.sym & 0xff);
            if (bytes.length >= 2048) {
                break;
            }
            node = huffmanRoot;
        }
    }
    const text = Buffer.from(bytes).toString('latin1');
    return text ? { text, endBit: bit } : null;
}

function reverseBits(byte: number): number {
    let out = 0;
    for (let i = 0; i < 8; i += 1) {
        out = (out << 1) | ((byte >> i) & 1);
    }
    return out & 0xff;
}

function scanObfuscatedAscii(payload: Buffer, startByte: number): string | null {
    const data = payload.subarray(startByte);
    const max = Math.min(data.length, 64);
    const slice = data.subarray(0, max);
    const candidates: string[] = [];

    const asText = Buffer.from(slice).toString('latin1');
    candidates.push(`raw:${asText}`);

    const reversed = Buffer.from(slice.map((b) => reverseBits(b)));
    candidates.push(`revbits:${reversed.toString('latin1')}`);

    for (let key = 0x20; key <= 0x7f; key += 1) {
        const xored = Buffer.from(slice.map((b) => (b ^ key) & 0xff));
        const text = xored.toString('latin1');
        if (text.includes('PING') || text.includes('GLB')) {
            return `xor_${key.toString(16).padStart(2, '0')}:${text}`;
        }
    }

    for (const candidate of candidates) {
        const printable = candidate.replace(/[^ -~]/g, '');
        if (printable.length >= 4) {
            return candidate;
        }
    }
    return null;
}

function isMostlyPrintable(text: string): boolean {
    if (!text) return false;
    let printable = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7e) printable += 1;
    }
    return printable / text.length >= 0.8;
}

function scanHuffmanAny(payload: Buffer): { order: 'msb' | 'lsb'; startBit: number; text: string } | null {
    const totalBits = payload.length * 8;
    const needles = ['PING', 'GLB', 'TEST'];
    for (let startBit = 0; startBit < totalBits; startBit += 1) {
        const msb = decodeHuffmanMsb(payload, startBit);
        if (msb?.text) {
            if (needles.some((n) => msb.text.includes(n)) || isMostlyPrintable(msb.text)) {
                return { order: 'msb', startBit, text: msb.text };
            }
        }
        const lsb = decodeHuffmanLsb(payload, startBit);
        if (lsb?.text) {
            if (needles.some((n) => lsb.text.includes(n)) || isMostlyPrintable(lsb.text)) {
                return { order: 'lsb', startBit, text: lsb.text };
            }
        }
    }
    return null;
}

function handleChatPacket95(packet: RakPacket): void {
    const data = Buffer.from(packet.data);
    const payload = data.subarray(1);
    const key = addressToString(packet.systemAddress);
    try {
        using reader = new LithPacketRead(payload);
        const senderId = readU32c(reader);
        const totalBits = payload.length * 8;
        const gapStart = reader.tell();

        const readBitAt = (order: 'msb' | 'lsb', bitIndex: number): number => {
            const byte = payload[bitIndex >> 3] ?? 0;
            return order === 'msb'
                ? (byte >> (7 - (bitIndex & 7))) & 1
                : (byte >> (bitIndex & 7)) & 1;
        };

        const readCompressedUIntAt = (bitPos: number, byteCount: number): { value: number; nextBit: number } => {
            let pos = bitPos;
            for (let i = byteCount - 1; i >= 1; i -= 1) {
                const isZero = readBitAt('lsb', pos) === 1;
                pos += 1;
                if (isZero) {
                    continue;
                }
                let value = 0;
                for (let j = i; j >= 0; j -= 1) {
                    let b = 0;
                    for (let k = 0; k < 8; k += 1) {
                        b |= readBitAt('lsb', pos) << k;
                        pos += 1;
                    }
                    value |= (b & 0xff) << (j * 8);
                }
                return { value, nextBit: pos };
            }
            let value = 0;
            for (let k = 0; k < 8; k += 1) {
                value |= readBitAt('lsb', pos) << k;
                pos += 1;
            }
            return { value, nextBit: pos };
        };

        const u8c = readCompressedUIntAt(gapStart, 1);
        const u32c = readCompressedUIntAt(u8c.nextBit, 4);
        const flagBit = readBitAt('lsb', u32c.nextBit);
        const padBits = (8 - ((u32c.nextBit + 1) % 8)) % 8;
        const computedStart = u32c.nextBit + 1 + padBits;
        // Observed from live captures: global chat string starts at bit 80.
        const startBit = 80;

        logInfo(
            `[Server] CHAT(0x95) header senderId=${senderId} u8c=${u8c.value} u32c=${u32c.value} ` +
                `flag=${flagBit} padBits=${padBits} start=${startBit} from ${key} raw=${hexPreview(data, 64)}`,
        );

        const decoded = decodeHuffmanMsb(payload, startBit);
        if (decoded) {
            logInfo(
                `[Server] CHAT(0x95) huff-msb senderId=${senderId} text="${decoded.text}" ` +
                    `start=${startBit} end=${decoded.endBit}/${totalBits} from ${key}`,
            );
            const normalized = decoded.text.trim().toLowerCase();
            if (normalized === '/ping' || normalized === 'ping') {
                const responseText = 'PONG';
                const reply = buildChat95Response(senderId, u8c.value, u32c.value, flagBit === 1, responseText);
                if (reply) {
                    sendReliable(reply, packet.systemAddress);
                    logInfo(`[Server] CHAT(0x95) -> /ping response "${responseText}" to ${key}`);
                }
                return;
            }
            if (normalized === '/who' || normalized === 'who') {
                const responseText = buildWhoResponse();
                const reply = buildChat95Response(senderId, u8c.value, u32c.value, flagBit === 1, responseText);
                if (reply) {
                    sendReliable(reply, packet.systemAddress);
                    logInfo(`[Server] CHAT(0x95) -> /who response "${responseText}" to ${key}`);
                }
                return;
            }
            return;
        }

        const decodedLsb = decodeHuffmanLsb(payload, startBit);
        if (decodedLsb) {
            logInfo(
                `[Server] CHAT(0x95) huff-lsb senderId=${senderId} text="${decodedLsb.text}" ` +
                    `start=${startBit} end=${decodedLsb.endBit}/${totalBits} from ${key}`,
            );
            return;
        }

        for (let scanStart = 64; scanStart <= 96; scanStart += 2) {
            const scan = decodeHuffmanMsb(payload, scanStart);
            if (scan && scan.text) {
                logInfo(
                    `[Server] CHAT(0x95) huff-msb scan senderId=${senderId} text="${scan.text}" ` +
                        `start=${scanStart} end=${scan.endBit}/${totalBits} from ${key}`,
                );
                return;
            }
        }

        const scan = scanObfuscatedAscii(payload, Math.floor(startBit / 8));
        if (scan) {
            logInfo(
                `[Server] CHAT(0x95) ascii scan senderId=${senderId} startByte=${Math.floor(
                    startBit / 8,
                )} text="${scan}" from ${key}`,
            );
            return;
        }

        const huffAny = scanHuffmanAny(payload);
        if (huffAny) {
            logInfo(
                `[Server] CHAT(0x95) huff-any senderId=${senderId} order=${huffAny.order} ` +
                    `start=${huffAny.startBit} text="${huffAny.text}" from ${key}`,
            );
            return;
        }

        logInfo(`[Server] CHAT(0x95) huff decode failed senderId=${senderId} start=${startBit} from ${key}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logInfo(`[Server] CHAT(0x95) decode error from ${key}: ${msg}`);
    }
}

// Encode a minimal 0x95 reply using the client's compressed string format.
function buildChat95Response(
    senderId: number,
    u8c: number,
    u32c: number,
    flagBit: boolean,
    text: string,
): Buffer | null {
    let bs: NativeBitStream | null = null;
    try {
        const clamped = text.length >= 2048 ? text.slice(0, 2047) : text;
        bs = new NativeBitStream();
        bs.writeU8(0x95);
        bs.writeCompressedU32(senderId >>> 0);
        bs.writeCompressedU8(u8c & 0xff);
        bs.writeCompressedU32(u32c >>> 0);
        bs.writeBit(flagBit ? 1 : 0);
        bs.alignWriteToByteBoundary();
        bs.writeCompressedString(clamped, 2048);
        return bs.getData();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logInfo(`[Server] CHAT(0x95) build reply failed: ${msg}`);
        return null;
    } finally {
        bs?.destroy();
    }
}

function buildWhoResponse(): string {
    const all = connections.getAll();
    if (all.length === 0) return 'WHO: 0 online';
    const entries = all.slice(0, 8).map((conn) => {
        const name = conn.username || conn.pendingLoginUser || conn.key;
        return name;
    });
    const extra = all.length > entries.length ? ` +${all.length - entries.length} more` : '';
    return `WHO: ${entries.join(', ')}${extra}`;
}

handlers.set(0x95, (packet) => {
    handleChatPacket95(packet);
});

const DEBUG_INBOUND_IDS = true;
const DEBUG_INBOUND_THROTTLE_MS = 500;
const inboundSeen = new Map<string, number>();

function logInboundPacket(address: RakSystemAddress, messageId: number, length: number): void {
    if (!DEBUG_INBOUND_IDS) {
        return;
    }
    const key = `${addressToIp(address)}:${address.port}|${messageId}|${length}`;
    const now = Date.now();
    const last = inboundSeen.get(key) ?? 0;
    if (now - last < DEBUG_INBOUND_THROTTLE_MS) {
        return;
    }
    inboundSeen.set(key, now);
    logInfo(
        `[Server] IN msg=0x${messageId.toString(16).padStart(2, '0')} len=${length} from ${addressToString(
            address,
        )}`,
    );
}

function hexPreview(data: Buffer, maxBytes: number = 64): string {
    const slice = data.subarray(0, Math.min(maxBytes, data.length));
    const hex = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    return data.length > maxBytes ? `${hex} ...` : hex;
}

// =============================================================================
// Packet Unwrap Helpers (RakNet timestamp/user packet)
// =============================================================================

function hexDump(buffer: Buffer, maxBytes = 64): { hex: string; truncated: boolean } {
    const truncated = buffer.length > maxBytes;
    const view = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const hex = Array.from(view)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    return { hex, truncated };
}

function unwrapPacketPayload(data: Buffer): {
    outerId: number;
    innerId: number | null;
    innerPacket: Buffer | null;
    lithId: number | null;
    lithPayload: Buffer | null;
} {
    const outerId = data[0] ?? 0;
    let innerId: number | null = null;
    let innerPacket: Buffer | null = null;
    let lithId: number | null = null;
    let lithPayload: Buffer | null = null;

    if (outerId === RakNetMessageId.ID_TIMESTAMP) {
        if (data.length >= 6) {
            // RakNetTime is 32-bit unless __GET_TIME_64BIT is enabled.
            innerPacket = data.subarray(5);
            innerId = innerPacket[0] ?? null;
        }
    } else {
        innerPacket = data;
        innerId = outerId;
    }

    if (innerId === RakNetMessageId.ID_USER_PACKET_ENUM && innerPacket && innerPacket.length >= 2) {
        lithId = innerPacket[1];
        lithPayload = innerPacket.subarray(2);
    }

    return { outerId, innerId, innerPacket, lithId, lithPayload };
}

// =============================================================================
// Main Loop
// =============================================================================

async function mainLoop() {
    logInfo('[Server] Starting main loop...');
    logInfo('');

    while (peer.isActive()) {
        // Process all pending packets
        let packet = peer.receive();
        while (packet) {
            // Log inbound packet before dispatch.
            const addrIp = addressToIp(packet.systemAddress);
            const connection = connections.get(packet.systemAddress);
            const incomingPacket = {
                timestamp: new Date(),
                direction: PacketDirection.INCOMING,
                address: addrIp,
                port: packet.systemAddress.port,
                data: Buffer.from(packet.data),
                connectionId: connection?.id,
            };
            try {
                const logged = packetLogger.log(incomingPacket);
                packetLogger.logAnalysis(incomingPacket, logged);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                PacketLogger.globalNote(
                    `[Error] packetLog RECV addr=${addrIp}:${packet.systemAddress.port} len=${packet.length} err=${msg}`,
                );
            }

            const messageId = packet.data[0];
            logInboundPacket(packet.systemAddress, messageId, packet.length);
            const handler = handlers.get(messageId);

            if (handler) {
                try {
                    handler(packet);
                } catch (err) {
                    const addr = addressToString(packet.systemAddress);
                    const errText = err instanceof Error ? err.stack || err.message : String(err);
                    logError(
                        `[Server] Error handling packet 0x${messageId.toString(16)} from ${addr}: ${errText}`,
                    );
                }
            } else {
                // Log unknown packets
                if (config.debug || messageId >= 0x50) {  // Log game packets
                    const addr = addressToString(packet.systemAddress);
                    const unwrap = unwrapPacketPayload(packet.data);
                    logInfo(
                        `[Server] Unhandled 0x${messageId.toString(16).padStart(2, '0')} from ${addr} (${packet.length} bytes)`,
                    );
                    if (unwrap.innerPacket && unwrap.outerId === RakNetMessageId.ID_TIMESTAMP) {
                        logInfo(
                            `[Server] -> ID_TIMESTAMP innerId=0x${(unwrap.innerId ?? 0).toString(16).padStart(2, '0')} innerLen=${unwrap.innerPacket.length}`,
                        );
                    }
                    if (unwrap.lithId !== null && unwrap.lithPayload) {
                        logInfo(
                            `[Server] -> USER_PACKET lithId=0x${unwrap.lithId.toString(16).padStart(2, '0')} lithLen=${unwrap.lithPayload.length}`,
                        );
                    }
                    const dumpTarget = unwrap.lithPayload ?? unwrap.innerPacket ?? packet.data;
                    const { hex, truncated } = hexDump(dumpTarget, 96);
                    logInfo(`         ${hex}${truncated ? ' ...' : ''}`);
                }
            }

            // Get next packet
            packet = peer.receive();
        }

        // Small sleep to prevent busy-waiting
        await Bun.sleep(10);
    }

    logInfo('\n[Server] Main loop has exited.');
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

function shutdown() {
    logInfo('\n[Server] Shutting down...');
    peer.shutdown(500);
    peer.destroy();
    logInfo('[Server] Goodbye!');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
    const errText = err instanceof Error ? err.stack || err.message : String(err);
    logError(`[Server] Uncaught exception: ${errText}`);
    shutdown();
});
process.on('unhandledRejection', (reason) => {
    const reasonText = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logError(`[Server] Unhandled rejection: ${reasonText}`);
    shutdown();
});
process.on('beforeExit', (code) => {
    logInfo(`[Server] Process beforeExit event with code: ${code}`);
});

// =============================================================================
// Start
// =============================================================================

mainLoop().catch((err) => {
    const errText = err instanceof Error ? err.stack || err.message : String(err);
    logError(`[Server] Fatal error in main loop: ${errText}`);
    peer.shutdown(0);
    peer.destroy();
    process.exit(1);
});
