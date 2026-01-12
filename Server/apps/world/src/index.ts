/**
 * FoM World Server
 *
 * Handles in-world gameplay after players connect from the Master server.
 * Listens on port 62000 (default) for ID_WORLD_LOGIN (0x72) from clients
 * redirected by the master server.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    RakPeer,
    RakReliability,
    RakPriority,
    type RakSystemAddress,
    addressToIp,
    addressToString,
    PacketLogger,
    PacketDirection,
    LithPacketRead,
    NativeBitStream,
    readU32c,
    readU16c,
    readU8c,
    decodeStringDebug,
} from '@openfom/networking';
import {
    RakNetMessageId,
    LithTechMessageId,
    IdWorldLoginPacket,
    IdRegisterClientPacket,
    IdRegisterClientReturnPacket,
    IdWorldServicePacket,
    MsgPacketGroup,
    MsgPreloadList,
    MsgClientObjectId,
    MsgUnguaranteedUpdate,
    WorldSelectSubId,
    IdWorldSelectPacket,
} from '@openfom/packets';
import { FileLogger, configureLogger, debug as logDebug, error as logError, info as logInfo } from '@openfom/utils';
import { loadRuntimeConfig } from './config';

const runtime = loadRuntimeConfig();
const config = runtime.server;
const packetLogConfig = runtime.packetLog;

configureLogger({ quiet: packetLogConfig.quiet, debug: config.debug });

PacketLogger.installConsoleMirror({ echoToConsole: !packetLogConfig.quiet });

const packetLogger = new PacketLogger({
    console: !packetLogConfig.quiet && packetLogConfig.consoleMode !== 'off',
    file: packetLogConfig.logToFile,
    consoleMode: packetLogConfig.consoleMode,
    consoleMinIntervalMs: packetLogConfig.consoleMinIntervalMs,
    consolePacketIds: packetLogConfig.consolePacketIds,
    filePacketIds: packetLogConfig.filePacketIds,
    ignorePacketIds: packetLogConfig.ignorePacketIds,
    analysis: packetLogConfig.analysisEnabled,
    consoleRepeatSuppressMs: packetLogConfig.consoleRepeatSuppressMs,
    flushMode: packetLogConfig.flushMode,
    assumePayload: true,
});

PacketLogger.setGlobal(packetLogger);
PacketLogger.setConsoleMirrorEcho(!packetLogConfig.quiet);

process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logError(`[World] Uncaught exception: ${msg}`);
    FileLogger.globalWrite(`[World] Uncaught exception: ${msg}`);
    if (err instanceof Error && err.stack) {
        FileLogger.globalWrite(err.stack);
    }
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    logError(`[World] Unhandled rejection: ${msg}`);
    FileLogger.globalWrite(`[World] Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) {
        FileLogger.globalWrite(reason.stack);
    }
});

logInfo('='.repeat(60));
logInfo(' FoM World Server');
logInfo('='.repeat(60));
logInfo(`  Port: ${config.port}`);
logInfo(`  Max Connections: ${config.maxConnections}`);
logInfo(`  Debug: ${config.debug}`);
logInfo('='.repeat(60));
logInfo('');
logInfo('[World] Build stamp: chat95-dispatch-v2');

type HuffmanEntry = { sym: number; bitlen: number; bits: string };
type HuffmanNode = { zero?: HuffmanNode; one?: HuffmanNode; sym?: number };

const huffmanRoot: HuffmanNode | null = (() => {
    try {
        const tablePath = path.resolve(process.cwd(), '../master/huffman_table_runtime.json');
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
        logDebug(`[World] Huffman table load failed: ${(error as Error).message}`);
        return null;
    }
})();

const recentKickByAddr = new Map<string, number>();
let debugPacketBudget = 200;
const HANDLE_CHAT_PACKET_95 = true;
const CHAT_HANDLER_MODE: 'noop' | 'decode' = 'decode';
const CHAT_DECODE_MODE: 'sender-only' | 'sender+string' | 'full' = 'sender+string';
const CHAT_HUFFMAN_FIXED_START = 80;
const DEBUG_INBOUND_IDS = true;
const DEBUG_INBOUND_THROTTLE_MS = 500;
const ENABLE_TEST_SPAWN = process.env.FOM_TEST_SPAWN !== '0';

const TEST_SPAWN_PAYLOAD_HEX =
    '53 00 78 a0 00 00 06 9e 38 00 00 c3 0c 30 0b 10 6d 2d 82 f7 10 00 80 00 ' +
    '00 00 00 00 00 00 00 00 00 00 7d 00 00 00 3b 70 00 00 1f 40 00 00 0f a0 ' +
    '00 00 9c 41 e1 e1 e1 e1 e0 00 00 00 01 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 ' +
    'f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 f0 ' +
    'f0 f0 f0 f0 f0 c0 00 00 08 06 69 8a 81 ea cb 02 41 5e 1e 10 84 70 83 c3 08 ' +
    '42 10 42 08 78 43 c3 08 42 10 42 08 78 43 c3 08 42 10 42 08 78 43 c3 08 42 ' +
    '10 42 08 78 43 0c 30 00 78 78 78 78 46 34 ad 25 29 21 5a e8 28 1e';

const TEST_SPAWN_PACKET = Buffer.from(
    TEST_SPAWN_PAYLOAD_HEX.split(/\s+/).map((byte) => Number.parseInt(byte, 16) & 0xff),
);

interface WorldConnection {
    address: RakSystemAddress;
    key: string;
    playerId: number;
    worldId: number;
    worldInst: number;
    authenticated: boolean;
    registered: boolean;
    worldTimeOrigin: number;
    lithTechOutSeq: number;
    connectStage: number;
    lithTechBurstSent: boolean;
    lastWorldLoginRequestAt?: number;
    pingInterval?: ReturnType<typeof setInterval>;
    testSpawnSent?: boolean;
}

const connections = new Map<string, WorldConnection>();
let chatSeq = 0;
let lastChatPayload: Buffer | null = null;
let chatBitDumpRemaining = 2;
const inboundSeen = new Map<string, number>();

function getConnectionKey(address: RakSystemAddress): string {
    return `${addressToIp(address)}:${address.port}`;
}

function hexPreview(data: Buffer, maxBytes: number = 64): string {
    const slice = data.subarray(0, Math.min(maxBytes, data.length));
    const hex = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    return data.length > maxBytes ? `${hex} ...` : hex;
}

function logInboundPacket(
    address: RakSystemAddress,
    rawMessageId: number,
    messageId: number,
    length: number,
): void {
    if (!DEBUG_INBOUND_IDS) {
        return;
    }
    const key = `${addressToIp(address)}:${address.port}|${rawMessageId}|${messageId}|${length}`;
    const now = Date.now();
    const last = inboundSeen.get(key) ?? 0;
    if (now - last < DEBUG_INBOUND_THROTTLE_MS) {
        return;
    }
    inboundSeen.set(key, now);
    logInfo(
        `[World] IN msg=0x${messageId.toString(16).padStart(2, '0')} raw=0x${rawMessageId
            .toString(16)
            .padStart(2, '0')} len=${length}`,
    );
}

function bitsPreview(data: Buffer, order: 'msb' | 'lsb'): string {
    const bits: string[] = [];
    for (const byte of data) {
        for (let bit = 0; bit < 8; bit += 1) {
            const bitIndex = order === 'msb' ? 7 - bit : bit;
            bits.push(((byte >> bitIndex) & 1) ? '1' : '0');
        }
    }
    return bits.join('');
}

function unwrapTimestampPacket(data: Buffer): {
    rawMessageId: number;
    messageId: number;
    payload: Buffer;
    timestamp?: number;
} {
    const rawMessageId = data[0] ?? 0;
    if (rawMessageId !== RakNetMessageId.ID_TIMESTAMP || data.length < 6) {
        return {
            rawMessageId,
            messageId: rawMessageId,
            payload: data.subarray(1),
        };
    }

    return {
        rawMessageId,
        messageId: data[5],
        payload: data.subarray(6),
        timestamp: data.readUInt32LE(1),
    };
}

const peer = new RakPeer();

if (!peer.startup(config.maxConnections, config.port, 0)) {
    logError('[World] Failed to start RakNet peer');
    process.exit(1);
}

peer.setMaxIncomingConnections(config.maxConnections);
peer.setIncomingPassword(config.password);

logInfo(`[World] Listening on port ${config.port}`);
logInfo('');

function sendReliable(data: Buffer, address: RakSystemAddress): boolean {
    const addrIp = addressToIp(address);
    const connection = connections.get(getConnectionKey(address));
    const outgoingPacket = {
        timestamp: new Date(),
        direction: PacketDirection.OUTGOING,
        address: addrIp,
        port: address.port,
        data,
        connectionId: connection?.playerId,
    };
    try {
        packetLogger.log(outgoingPacket);
    } catch {}

    const success = peer.send(
        data,
        RakPriority.HIGH,
        RakReliability.RELIABLE,
        0,
        address,
        false,
    );
    if (config.debug) {
        const addr = addressToString(address);
        const msgId = data[0];
        logDebug(`[World] SEND 0x${msgId.toString(16).padStart(2, '0')} to ${addr} (${data.length} bytes) - ${success ? 'OK' : 'FAIL'}`);
    }
    return success;
}

function sendUnreliable(data: Buffer, address: RakSystemAddress): boolean {
    const success = peer.send(
        data,
        RakPriority.LOW,
        RakReliability.UNRELIABLE,
        0,
        address,
        false,
    );
    return success;
}

function sendLithTechBurst(conn: WorldConnection): void {
    const packetGroup = MsgPacketGroup.buildWorldLoginBurst(
        conn.playerId,
        conn.worldId,
        0.0,
    );
    const encoded = packetGroup.encode();
    sendReliable(encoded, conn.address);
    conn.lithTechBurstSent = true;
    logInfo(`[World] -> SMSG_PACKETGROUP (NETPROTOCOLVERSION + YOURID + LOADWORLD) worldId=${conn.worldId}, playerId=${conn.playerId}`);
}

function sendTestSpawnPacket(conn: WorldConnection): void {
    if (!ENABLE_TEST_SPAWN || conn.testSpawnSent) {
        return;
    }
    conn.testSpawnSent = true;
    const sent = sendReliable(TEST_SPAWN_PACKET, conn.address);
    logInfo(
        `[World] -> TEST_SPAWN SMSG_UPDATE replay (${TEST_SPAWN_PACKET.length} bytes) to ${conn.key} (${sent ? 'OK' : 'FAIL'})`
    );
}

function handleWorldLogin(packet: IdWorldLoginPacket, address: RakSystemAddress): void {
    const { worldId, worldInst, playerId, worldConst } = packet;
    const key = getConnectionKey(address);

    logInfo(`[World] 0x72 WORLD_LOGIN from ${key}: worldId=${worldId} inst=${worldInst} playerId=${playerId} const=0x${worldConst.toString(16)}`);

    const conn = connections.get(key);
    if (!conn) {
        logError(`[World] No connection found for ${key}`);
        return;
    }

    conn.playerId = playerId || 1;
    conn.worldId = worldId || 1;
    conn.worldInst = worldInst || 0;
    conn.authenticated = true;

    logInfo(`[World] Updated connection: playerId=${conn.playerId} worldId=${conn.worldId}`);
}

function handleRegisterClient(packet: IdRegisterClientPacket, address: RakSystemAddress): void {
    const { worldId, playerId, sessionId } = packet;
    const key = getConnectionKey(address);

    logInfo(`[World] 0x78 REGISTER_CLIENT from ${key}: worldId=${worldId} playerId=${playerId} sessionId=${sessionId}`);

    const conn = connections.get(key);
    if (!conn) {
        logError(`[World] No connection found for ${key}`);
        return;
    }

    conn.authenticated = true;

    conn.playerId = playerId || conn.playerId;
    conn.worldId = worldId || conn.worldId;
    conn.registered = true;

    const response = new IdRegisterClientReturnPacket({
        worldId: conn.worldId,
        worldInst: conn.playerId, // Client expects playerId in the 0x79 header slot.
        returnCode: 1,
    });
    
    const responseBuffer = response.encode();
    sendReliable(responseBuffer, address);
    logInfo(`[World] -> 0x79 REGISTER_CLIENT_RETURN (worldId=${conn.worldId}, playerId=${conn.playerId}, ${responseBuffer.length} bytes)`);

    // Test spawn replay to validate object update pipeline even if CONNECTSTAGE never arrives.
    sendTestSpawnPacket(conn);

    const gameTime = (Date.now() - conn.worldTimeOrigin) / 1000;
    const heartbeat = new MsgUnguaranteedUpdate({ objectId: conn.playerId, gameTime });
    sendUnreliable(heartbeat.encode(), address);
}

function handleNewConnection(address: RakSystemAddress): void {
    const key = getConnectionKey(address);
    logInfo(`[World] New connection from ${key}`);

    const conn: WorldConnection = {
        address,
        key,
        playerId: 1,
        worldId: 1,
        worldInst: 0,
        authenticated: false,
        registered: false,
        worldTimeOrigin: Date.now(),
        lithTechOutSeq: 0,
        connectStage: -1,
        lithTechBurstSent: false,
    };
    connections.set(key, conn);

    sendLithTechBurst(conn);
}

function handleWorldAuth(data: Buffer, address: RakSystemAddress): void {
    const key = getConnectionKey(address);
    const conn = connections.get(key);
    if (!conn) {
        logError(`[World] No connection found for ${key}`);
        return;
    }

    logInfo(`[World] 0x6b WORLD_LOGIN_REQUEST from ${key} (${data.length} bytes)`);
    const now = Date.now();
    const cooldownMs = 2000;
    if (!conn.lithTechBurstSent || !conn.lastWorldLoginRequestAt || now - conn.lastWorldLoginRequestAt > cooldownMs) {
        conn.lastWorldLoginRequestAt = now;
        sendLithTechBurst(conn);
        logInfo(`[World] -> resend LithTech burst after 0x6b`);
    }
}

function handleDisconnect(address: RakSystemAddress): void {
    const key = getConnectionKey(address);
    const conn = connections.get(key);
    if (conn?.pingInterval) {
        clearInterval(conn.pingInterval);
    }
    logInfo(`[World] Disconnected: ${key}`);
    connections.delete(key);
}

function handleConnectStage(data: Buffer, address: RakSystemAddress): void {
    const key = getConnectionKey(address);
    const conn = connections.get(key);
    if (!conn) {
        logError(`[World] CONNECTSTAGE: No connection found for ${key}`);
        return;
    }

    const stage = data[1];
    conn.connectStage = stage;
    logInfo(`[World] CMSG_CONNECTSTAGE from ${key}: stage=${stage}`);

    if (stage === 0) {
        logInfo(`[World] -> SMSG_PRELOADLIST (END) - client loaded world, sending preload end`);
        const preloadEnd = MsgPreloadList.createEnd();
        const encoded = preloadEnd.encode();
        sendReliable(encoded, conn.address);
    } else if (stage === 1) {
        logInfo(`[World] -> SMSG_CLIENTOBJECTID - client preloaded, sending object ID ${conn.playerId}`);
        const clientObjId = MsgClientObjectId.create(conn.playerId);
        const encoded = clientObjId.encode();
        sendReliable(encoded, conn.address);
        sendTestSpawnPacket(conn);
    }
}

function handleUserPacket(payload: Buffer, address: RakSystemAddress, timestamp?: number): void {
    using reader = new LithPacketRead(payload);
    const ltMessageId = reader.readUint8();
    const key = getConnectionKey(address);

    if (ltMessageId === LithTechMessageId.MSG_MESSAGE) {
        const packetId = reader.readUint8();
        const readPos = reader.tell;
        let chatText = '';
        let senderId = 0;

        try {
            senderId = readU32c(reader);
            chatText = reader.readString(2048);
            reader.readBool();
        } catch {
            reader.seekTo(readPos);
        }

        if (chatText) {
            const prefix = timestamp ? `[ts=${timestamp}] ` : '';
            logInfo(`[World] ${prefix}CHAT packetId=0x${packetId.toString(16)} from ${key} senderId=${senderId} text="${chatText}"`);
            if (chatText.startsWith('/')) {
                logInfo(`[World] CHAT command from ${key}: ${chatText}`);
            }
            return;
        }

        logInfo(`[World] MSG_MESSAGE packetId=0x${packetId.toString(16)} from ${key} (${payload.length} bytes) payload=${hexPreview(payload)}`);
        return;
    }

    logInfo(`[World] LT MSG 0x${ltMessageId.toString(16)} from ${key} (${payload.length} bytes) payload=${hexPreview(payload)}`);
}

function handleChatPacket95(data: Buffer, address: RakSystemAddress): void {
    if (CHAT_HANDLER_MODE === 'noop') {
        const key = getConnectionKey(address);
        logInfo(`[World] CHAT(0x95) handler noop from ${key} (${data.length} bytes)`);
        return;
    }
    const key = getConnectionKey(address);
    if (CHAT_DECODE_MODE === 'sender-only') {
        try {
            using reader = new LithPacketRead(data.subarray(1));
            const senderId = readU32c(reader);
            logInfo(`[World] CHAT(0x95) sender-only from ${key} senderId=${senderId}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logInfo(`[World] CHAT(0x95) sender-only failed from ${key}: ${msg}`);
        }
        return;
    }
    if (CHAT_DECODE_MODE === 'sender+string') {
        try {
            using reader = new LithPacketRead(data.subarray(1));
            const senderId = readU32c(reader);
            const payload = data.subarray(1);
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
                    return { value: value >>> 0, nextBit: pos };
                }
                const useNibble = readBitAt('lsb', pos) === 1;
                pos += 1;
                if (useNibble) {
                    let value = 0;
                    for (let k = 0; k < 4; k += 1) {
                        value |= readBitAt('lsb', pos) << k;
                        pos += 1;
                    }
                    return { value: value >>> 0, nextBit: pos };
                }
                let value = 0;
                for (let k = 0; k < 8; k += 1) {
                    value |= readBitAt('lsb', pos) << k;
                    pos += 1;
                }
                return { value: value >>> 0, nextBit: pos };
            };

            // Header fields before the Huffman string (mirrors client write order).
            const u8c = readCompressedUIntAt(gapStart, 1);
            const u32c = readCompressedUIntAt(u8c.nextBit, 4);
            const flagBit = u32c.nextBit < totalBits ? readBitAt('lsb', u32c.nextBit) : -1;
            const afterFlag = u32c.nextBit + (flagBit >= 0 ? 1 : 0);
            const padBits = Math.max(0, (8 - (afterFlag % 8)) % 8);
            const computedStart = Math.min(afterFlag + padBits, totalBits);
            // World chat strings usually start after alignment; fall back to a fixed start if needed.
            const startBit = computedStart > 0 ? computedStart : Math.min(CHAT_HUFFMAN_FIXED_START, totalBits);

            logInfo(
                `[World] CHAT(0x95) header senderId=${senderId} u8c=${u8c.value} ` +
                `u32c=${u32c.value} flag=${flagBit} padBits=${padBits} start=${startBit} ` +
                `raw=${hexPreview(data, 64)}`
            );

            // Decode a null-terminated Huffman string with the requested bit order.
            const decodeHuffmanNullTerm = (order: 'msb' | 'lsb'): { text: string; endBit: number } => {
                if (!huffmanRoot) return { text: '', endBit: startBit };
                const out: number[] = [];
                let node: HuffmanNode | undefined = huffmanRoot;
                let bitIndex = startBit;
                for (; bitIndex < totalBits; bitIndex += 1) {
                    const bit = readBitAt(order, bitIndex);
                    node = bit ? node.one : node.zero;
                    if (!node) break;
                    if (node.sym !== undefined) {
                        if (node.sym === 0) {
                            bitIndex += 1;
                            break;
                        }
                        out.push(node.sym & 0xff);
                        if (out.length >= 2048) {
                            bitIndex += 1;
                            break;
                        }
                        node = huffmanRoot;
                    }
                }
                return { text: Buffer.from(out).toString('latin1'), endBit: bitIndex };
            };

            const isCandidate = (value: string): boolean => {
                const normalized = value.replace(/\0/g, '');
                if (!normalized) return false;
                if (!/[A-Za-z0-9]/.test(normalized)) return false;
                if (normalized.length > 64) return false;
                return true;
            };

            const decoded = decodeHuffmanNullTerm('msb');
            if (isCandidate(decoded.text)) {
                const flagBit = decoded.endBit < totalBits ? readBitAt('msb', decoded.endBit) : -1;
                logInfo(
                    `[World] CHAT(0x95) huff-msb from ${key} senderId=${senderId} ` +
                    `text="${decoded.text}" flag=${flagBit} start=${startBit} end=${decoded.endBit}/${totalBits}`
                );
                const normalized = decoded.text.trim().toLowerCase();
                // Debug commands for validation; not part of gameplay.
                if (normalized === '/ping' || normalized === 'ping') {
                    const reply = buildChat95Response(1, u8c.value, u32c.value, flagBit === 1, '[SERVER] PONG');
                    if (reply) {
                        sendReliable(reply, address);
                        logInfo(`[World] CHAT(0x95) -> /ping response "[SERVER] PONG" to ${key}`);
                    }
                    return;
                }
                if (normalized === '/who' || normalized === 'who') {
                    const reply = buildChat95Response(
                        1,
                        u8c.value,
                        u32c.value,
                        flagBit === 1,
                        '[SERVER] WHO: 1 online',
                    );
                    if (reply) {
                        sendReliable(reply, address);
                        logInfo(`[World] CHAT(0x95) -> /who response "[SERVER] WHO: 1 online" to ${key}`);
                    }
                    return;
                }
                if (decoded.text.trim() === '`') {
                    const reply = buildChat95Response(1, u8c.value, u32c.value, flagBit === 1, '[SERVER] BACKTICK');
                    if (reply) {
                        sendReliable(reply, address);
                        logInfo(`[World] CHAT(0x95) -> backtick response "[SERVER] BACKTICK" to ${key}`);
                    }
                    return;
                }
            } else {
                logInfo(
                    `[World] CHAT(0x95) huff-msb decode failed from ${key} senderId=${senderId} start=${startBit} total=${totalBits}`
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logInfo(`[World] CHAT(0x95) sender+string failed from ${key}: ${msg}`);
        }
        return;
    }
    let text = '';
    let senderId = 0;
    let chatFlag = false;
    let decodeMode = 'unknown';
    const packetId = data[0] ?? 0x95;

    const summarizeText = (value: string): { preview: string; hex: string; printable: boolean } => {
        const normalized = value.replace(/\0/g, '');
        const preview = normalized.replace(/[\r\n\t]/g, '');
        const buf = Buffer.from(normalized, 'latin1');
        const hex = buf.length ? buf.toString('hex') : '';
        const printable = /[A-Za-z0-9]/.test(preview);
        return { preview, hex, printable };
    };

    const logDecoded = (mode: string, id: number, flag: boolean, value: string): boolean => {
        const normalized = value.replace(/\0/g, '');
        const summary = summarizeText(normalized);
        logInfo(
            `[World] CHAT(0x${packetId.toString(16)}) from ${key} senderId=${id} flag=${flag ? 1 : 0} ` +
            `text="${summary.preview}" hex=${summary.hex} mode=${mode}`
        );
        return summary.printable;
    };

    chatSeq += 1;
    let diffInfo = 'first';
    if (lastChatPayload) {
        const same = lastChatPayload.equals(data);
        if (same) {
            diffInfo = 'same-as-prev';
        } else {
            const minLen = Math.min(lastChatPayload.length, data.length);
            let firstDiff = -1;
            let diffCount = 0;
            for (let i = 0; i < minLen; i += 1) {
                if (lastChatPayload[i] !== data[i]) {
                    diffCount += 1;
                    if (firstDiff === -1) firstDiff = i;
                }
            }
            diffCount += Math.abs(lastChatPayload.length - data.length);
            diffInfo = `diff bytes=${diffCount} firstDiff=${firstDiff}`;
        }
    }
    lastChatPayload = Buffer.from(data);
    logInfo(`[World] CHAT(0x${packetId.toString(16)}) seq=${chatSeq} len=${data.length} ${diffInfo}`);
    logInfo(`[World] CHAT(0x${packetId.toString(16)}) raw=${hexPreview(data, 96)}`);
    if (chatBitDumpRemaining > 0) {
        const payload = data.subarray(1);
        logInfo(`[World] CHAT(0x${packetId.toString(16)}) bits-msb=${bitsPreview(payload, 'msb')}`);
        logInfo(`[World] CHAT(0x${packetId.toString(16)}) bits-lsb=${bitsPreview(payload, 'lsb')}`);
        chatBitDumpRemaining -= 1;
    }

    const decodeHuffman = (buffer: Buffer, bitCount: number, order: 'msb' | 'lsb'): string => {
        if (!huffmanRoot || bitCount <= 0) return '';
        const out: number[] = [];
        let node: HuffmanNode | undefined = huffmanRoot;
        const maxChars = 2048;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const byte = buffer[bitIndex >> 3] ?? 0;
            const bit =
                order === 'msb'
                    ? (byte >> (7 - (bitIndex & 7))) & 1
                    : (byte >> (bitIndex & 7)) & 1;
            node = bit ? node.one : node.zero;
            if (!node) break;
            if (node.sym !== undefined) {
                if (node.sym === 0) break;
                out.push(node.sym & 0xff);
                if (out.length >= maxChars) break;
                node = huffmanRoot;
            }
        }
        return Buffer.from(out).toString('latin1');
    };

    logInfo(`[World] CHAT(0x${packetId.toString(16)}) decode-attempt=manual-u32c-huffbits`);
    const payload = data.subarray(1);
    const totalBits = payload.length * 8;
    const peekBits = payload.subarray(0, 4);
    logInfo(`[World] CHAT(0x${packetId.toString(16)}) msb peek32=${peekBits.toString('hex')}`);
    logInfo(`[World] CHAT(0x${packetId.toString(16)}) lsb peek32=${bitsPreview(peekBits, 'lsb')}`);

    const readBitAt = (order: 'msb' | 'lsb', bitIndex: number): number => {
        const byte = payload[bitIndex >> 3] ?? 0;
        return order === 'msb'
            ? (byte >> (7 - (bitIndex & 7))) & 1
            : (byte >> (bitIndex & 7)) & 1;
    };

    const decodeHuffmanAtLocal = (startBit: number, bitCount: number, order: 'msb' | 'lsb'): string => {
        if (!huffmanRoot || bitCount <= 0 || startBit < 0) return '';
        const out: number[] = [];
        let node: HuffmanNode | undefined = huffmanRoot;
        const maxChars = 2048;
        for (let bitOffset = 0; bitOffset < bitCount; bitOffset += 1) {
            const bitIndex = startBit + bitOffset;
            const bit = readBitAt(order, bitIndex);
            node = bit ? node.one : node.zero;
            if (!node) break;
            if (node.sym !== undefined) {
                if (node.sym === 0) break;
                out.push(node.sym & 0xff);
                if (out.length >= maxChars) break;
                node = huffmanRoot;
            }
        }
        return Buffer.from(out).toString('latin1');
    };

    const readCompressedUIntBits = (
        order: 'msb' | 'lsb',
        startBit: number,
        byteCount: number,
    ): { value: number; nextBit: number } => {
        let bitPos = startBit;
        const readBit = (): number => {
            const bit = readBitAt(order, bitPos);
            bitPos += 1;
            return bit;
        };
        const readBits = (count: number): number => {
            let value = 0;
            for (let i = 0; i < count; i += 1) {
                const bit = readBit();
                if (order === 'msb') {
                    value = (value << 1) | bit;
                } else {
                    value |= bit << i;
                }
            }
            return value >>> 0;
        };
        const bytes = Math.max(1, Math.min(4, byteCount));
        for (let i = bytes - 1; i >= 1; i -= 1) {
            const isZero = readBit() === 1;
            if (isZero) {
                continue;
            }
            let value = 0;
            for (let j = i; j >= 0; j -= 1) {
                const b = readBits(8);
                value |= b << (j * 8);
            }
            return { value: value >>> 0, nextBit: bitPos };
        }
        const useNibble = readBit() === 1;
        const value = useNibble ? readBits(4) : readBits(8);
        return { value: value >>> 0, nextBit: bitPos };
    };

    (['msb', 'lsb'] as const).forEach((order) => {
        let bitPos = 0;
        const sender = readCompressedUIntBits(order, bitPos, 4);
        bitPos = sender.nextBit;
        logInfo(
            `[World] CHAT(0x${packetId.toString(16)}) ${order} fields senderId=${sender.value} pos=${bitPos}/${totalBits}`
        );
        const candidates = [
            { bytes: 1, asBits: true },
            { bytes: 2, asBits: true },
            { bytes: 4, asBits: true },
            { bytes: 1, asBits: false },
            { bytes: 2, asBits: false },
            { bytes: 4, asBits: false },
        ];
        for (const candidate of candidates) {
            const count = readCompressedUIntBits(order, bitPos, candidate.bytes);
            let bitCount = count.value;
            if (!candidate.asBits) {
                bitCount = bitCount * 8;
            }
            const label = `manual-${order}-u${candidate.bytes * 8}c${candidate.asBits ? '' : '-bytes'}`;
            logInfo(
                `[World] CHAT(0x${packetId.toString(16)}) ${label} bitCount=${bitCount} pos=${count.nextBit}/${totalBits}`
            );
            if (bitCount > 0 && count.nextBit + bitCount <= totalBits) {
                const msbText = decodeHuffmanAtLocal(count.nextBit, bitCount, 'msb');
                if (isCandidateText(msbText)) {
                    logDecoded(`${label}-msb`, sender.value, false, msbText);
                }
                const lsbText = decodeHuffmanAtLocal(count.nextBit, bitCount, 'lsb');
                if (isCandidateText(lsbText)) {
                    logDecoded(`${label}-lsb`, sender.value, false, lsbText);
                }
            }
        }
    });
    return;

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readCompressedU32();
        text = bs.readCompressedString(2048).value;
        chatFlag = bs.readBit();
        decodeMode = 'msb-u32c-huff';
        if (logDecoded(decodeMode, senderId, chatFlag, text)) {
            return;
        }
    } catch {}

    return;

    const decodeHuffmanAt = (buffer: Buffer, startBit: number, bitCount: number, order: 'msb' | 'lsb'): string => {
        if (!huffmanRoot || bitCount <= 0 || startBit < 0) return '';
        const out: number[] = [];
        let node: HuffmanNode | undefined = huffmanRoot;
        const maxChars = 2048;
        for (let bitOffset = 0; bitOffset < bitCount; bitOffset += 1) {
            const bitIndex = startBit + bitOffset;
            const byte = buffer[bitIndex >> 3] ?? 0;
            const bit =
                order === 'msb'
                    ? (byte >> (7 - (bitIndex & 7))) & 1
                    : (byte >> (bitIndex & 7)) & 1;
            node = bit ? node.one : node.zero;
            if (!node) break;
            if (node.sym !== undefined) {
                if (node.sym === 0) break;
                out.push(node.sym & 0xff);
                if (out.length >= maxChars) break;
                node = huffmanRoot;
            }
        }
        return Buffer.from(out).toString('latin1');
    };

    const isCandidateText = (value: string): boolean => {
        const normalized = value.replace(/\0/g, '');
        if (!normalized) return false;
        if (!/[A-Za-z0-9]/.test(normalized)) return false;
        if (normalized.length > 64) return false;
        const unique = new Set(normalized.split(''));
        if (unique.size <= 2 && normalized.length > 4) return false;
        return true;
    };

    const scanHuffman = (label: string, startBits: number, maxOffset: number, maxTextLen: number): void => {
        const payload = data.subarray(1);
        const totalBits = payload.length * 8;
        for (let offset = 0; offset <= maxOffset; offset += 1) {
            const startBit = startBits + offset;
            const remaining = totalBits - startBit;
            if (remaining <= 0) break;
            const msb = decodeHuffmanAt(payload, startBit, remaining, 'msb');
            if (isCandidateText(msb)) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) ${label} bit=${startBit} text="${msb.slice(0, maxTextLen)}" mode=huff-scan-msb`);
            }
            const lsb = decodeHuffmanAt(payload, startBit, remaining, 'lsb');
            if (isCandidateText(lsb)) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) ${label} bit=${startBit} text="${lsb.slice(0, maxTextLen)}" mode=huff-scan-lsb`);
            }
        }
    };

    const tryHuffman = (
        label: string,
        readSender: (reader: LithPacketRead) => number,
        readCount: (reader: LithPacketRead) => number,
        asBytes: boolean = false,
    ): boolean => {
        try {
            using reader = new LithPacketRead(data.subarray(1));
            senderId = readSender(reader);
            const rawCount = readCount(reader);
            const totalBits = (data.length - 1) * 8;
            const remaining = Math.max(0, totalBits - reader.tell());
            let bitCount = Math.max(0, rawCount);
            if (asBytes) {
                bitCount = bitCount * 8;
            }
            if (bitCount > remaining) {
                bitCount = remaining;
            }
            logDebug(
                `[World] CHAT(0x${packetId.toString(16)}) ${label} sender=${senderId} ` +
                `count=${rawCount} bits=${bitCount} remaining=${remaining} pos=${reader.tell()}/${totalBits}`,
            );
            if (bitCount <= 0) {
                return false;
            }
            const bits = reader.readData(bitCount);
            text = decodeHuffman(bits, bitCount, 'msb');
            if (logDecoded(`${label}-msb`, senderId, false, text)) {
                return true;
            }
            text = decodeHuffman(bits, bitCount, 'lsb');
            if (logDecoded(`${label}-lsb`, senderId, false, text)) {
                return true;
            }
        } catch {}
        return false;
    };

    const readSenderRaw = (reader: LithPacketRead): number => reader.readUint32();
    const readSenderCompressed = (reader: LithPacketRead): number => readU32c(reader);

    if (tryHuffman('lith-huff-raw-u8c-bytes', readSenderRaw, readU8c, true)) {
        return;
    }
    if (tryHuffman('lith-huff-raw-u8c', readSenderRaw, readU8c)) {
        return;
    }
    if (tryHuffman('lith-huff-raw-u16c', readSenderRaw, readU16c)) {
        return;
    }
    if (tryHuffman('lith-huff-raw-u32c', readSenderRaw, readU32c)) {
        return;
    }
    if (tryHuffman('lith-huff-u32c', readSenderCompressed, readU32c)) {
        return;
    }
    if (tryHuffman('lith-huff-u16c', readSenderCompressed, readU16c)) {
        return;
    }
    if (tryHuffman('lith-huff-u8c', readSenderCompressed, readU8c)) {
        return;
    }
    if (tryHuffman('lith-huff-u16c-bytes', readSenderCompressed, readU16c, true)) {
        return;
    }

    scanHuffman('scan-after-sender', 32, 48, 16);
    scanHuffman('scan-from-start', 0, 48, 16);

    const scanHuffmanTail = (label: string, tailBytes: number, maxOffset: number, maxTextLen: number): void => {
        const payload = data.subarray(1);
        const totalBits = payload.length * 8;
        const tailStart = Math.max(0, totalBits - tailBytes * 8);
        for (let offset = 0; offset <= maxOffset; offset += 1) {
            const startBit = Math.max(0, tailStart - offset);
            const remaining = totalBits - startBit;
            const msb = decodeHuffmanAt(payload, startBit, remaining, 'msb');
            if (isCandidateText(msb)) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) ${label} bit=${startBit} text="${msb.slice(0, maxTextLen)}" mode=huff-tail-msb`);
            }
            const lsb = decodeHuffmanAt(payload, startBit, remaining, 'lsb');
            if (isCandidateText(lsb)) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) ${label} bit=${startBit} text="${lsb.slice(0, maxTextLen)}" mode=huff-tail-lsb`);
            }
        }
    };

    scanHuffmanTail('scan-tail-2b', 2, 16, 16);
    scanHuffmanTail('scan-tail-6b', 6, 24, 16);
    scanHuffmanTail('scan-tail-8b', 8, 24, 16);

    const scanBuffer = data.subarray(1);
    const scanBits = Math.min(scanBuffer.length * 8, 128);
    for (let bitOffset = 0; bitOffset < scanBits; bitOffset += 1) {
        try {
            using bs = new NativeBitStream(scanBuffer);
            if (bitOffset > 0) {
                bs.readBits(bitOffset, true);
            }
            const guess = decodeStringDebug(bs, 2048);
            const summary = summarizeText(guess);
            if (summary.printable) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) bit=${bitOffset} guess="${summary.preview}" hex=${summary.hex} mode=bit-scan`);
            }
        } catch {}
    }

    for (let offset = 1; offset <= Math.min(8, data.length - 1); offset += 1) {
        try {
            using bs = new NativeBitStream(data.subarray(offset));
            const guess = decodeStringDebug(bs, 2048);
            const summary = summarizeText(guess);
            if (summary.printable) {
                logInfo(`[World] CHAT(0x${packetId.toString(16)}) offset=${offset} guess="${summary.preview}" hex=${summary.hex} mode=debug-scan`);
            }
        } catch {}
    }

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        text = decodeStringDebug(bs, 2048);
        decodeMode = 'debug-string-only';
        logDecoded(decodeMode, 0, false, text);
        return;
    } catch {}

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readCompressedU8();
        text = decodeStringDebug(bs, 2048);
        decodeMode = 'debug-u8+string';
        logDecoded(decodeMode, senderId, false, text);
        return;
    } catch {}

    try {
        using reader = new LithPacketRead(data.subarray(1));
        senderId = readU32c(reader);
        text = reader.readString(2048);
        chatFlag = reader.readBool();
        decodeMode = 'lith-string';
        logDecoded(decodeMode, senderId, chatFlag, text);
        return;
    } catch {}

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readCompressedU32();
        text = bs.readCompressedString(2048).value;
        chatFlag = bs.readBit();
        decodeMode = 'compressed-string';
        logDecoded(decodeMode, senderId, chatFlag, text);
        return;
    } catch {}

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readCompressedU32();
        text = decodeStringDebug(bs, 2048);
        chatFlag = bs.readBit();
        decodeMode = 'debug-compressed';
        logDecoded(decodeMode, senderId, chatFlag, text);
        return;
    } catch {}

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readU32();
        text = bs.readCompressedString(2048).value;
        chatFlag = bs.readBit();
        decodeMode = 'raw-u32+compressed';
        logDecoded(decodeMode, senderId, chatFlag, text);
        return;
    } catch {}

    try {
        using bs = new NativeBitStream(data);
        bs.readU8();
        senderId = bs.readU32();
        text = bs.readString(2048, 'latin1');
        chatFlag = bs.readBit();
        decodeMode = 'raw-u32+string';
        logDecoded(decodeMode, senderId, chatFlag, text);
        return;
    } catch {}

    logInfo(`[World] CHAT(0x95) decode failed (${decodeMode}) from ${key} payload=${hexPreview(data)}`);
}

async function mainLoop() {
    logInfo('[World] Starting main loop...');
    logInfo('');

    while (peer.isActive()) {
        let packet = peer.receive();
        while (packet) {
            const addrIp = addressToIp(packet.systemAddress);
            const connection = connections.get(getConnectionKey(packet.systemAddress));
            const incomingPacket = {
                timestamp: new Date(),
                direction: PacketDirection.INCOMING,
                address: addrIp,
                port: packet.systemAddress.port,
                data: Buffer.from(packet.data),
                connectionId: connection?.playerId,
            };
            try {
                packetLogger.log(incomingPacket);
            } catch {}

            const rawData = Buffer.from(packet.data);
            const rawMessageId = rawData[0] ?? 0;
            const unwrapped = unwrapTimestampPacket(rawData);
            const messageId = unwrapped.messageId;
            const payload = unwrapped.payload;
            logInboundPacket(packet.systemAddress, rawMessageId, messageId, packet.length);
            const decodedBuffer =
                unwrapped.rawMessageId === RakNetMessageId.ID_TIMESTAMP
                    ? Buffer.concat([Buffer.from([messageId]), payload])
                    : rawData;
            if (rawMessageId === 0x95 && messageId !== 0x95) {
                const note = `[World] DEBUG forcing chat handler on raw 0x95 (msgId=0x${messageId.toString(16)})`;
                logInfo(note);
                PacketLogger.globalNote(note);
                FileLogger.globalWrite(note);
                if (HANDLE_CHAT_PACKET_95) {
                    handleChatPacket95(rawData, packet.systemAddress);
                }
                packet = peer.receive();
                continue;
            }

            const connectionKey = getConnectionKey(packet.systemAddress);
            if (!connections.has(connectionKey) && messageId !== RakNetMessageId.ID_NEW_INCOMING_CONNECTION) {
                const lastKick = recentKickByAddr.get(connectionKey) ?? 0;
                const now = Date.now();
                if (now - lastKick > 2000) {
                    recentKickByAddr.set(connectionKey, now);
                    logInfo(
                        `[World] Forcing disconnect for stale client ${connectionKey} (msg 0x${messageId.toString(16)})`
                    );
                    peer.closeConnection(packet.systemAddress, true);
                }
            }

            switch (messageId) {
                case RakNetMessageId.ID_NEW_INCOMING_CONNECTION:
                    handleNewConnection(packet.systemAddress);
                    break;

                case RakNetMessageId.ID_DISCONNECTION_NOTIFICATION:
                case RakNetMessageId.ID_CONNECTION_LOST:
                    handleDisconnect(packet.systemAddress);
                    break;

                case RakNetMessageId.ID_WORLD_LOGIN: {
                    const worldLoginPacket = IdWorldLoginPacket.decode(decodedBuffer);
                    handleWorldLogin(worldLoginPacket, packet.systemAddress);
                    break;
                }

                case RakNetMessageId.ID_WORLD_LOGIN_REQUEST: {
                    handleWorldAuth(decodedBuffer, packet.systemAddress);
                    break;
                }

                case RakNetMessageId.ID_WORLDSERVICE: {
                    const worldServicePacket = IdWorldServicePacket.decode(decodedBuffer);
                    const key = getConnectionKey(packet.systemAddress);
                    logInfo(`[World] 0xa5 WORLDSERVICE from ${key}: ${worldServicePacket.toString()}`);
                    break;
                }

                case RakNetMessageId.ID_REGISTER_CLIENT: {
                    const registerPacket = IdRegisterClientPacket.decode(decodedBuffer);
                    handleRegisterClient(registerPacket, packet.systemAddress);
                    break;
                }

                case LithTechMessageId.MSG_CONNECTSTAGE: {
                    handleConnectStage(decodedBuffer, packet.systemAddress);
                    break;
                }

                case RakNetMessageId.ID_USER_PACKET_ENUM: {
                    handleUserPacket(payload, packet.systemAddress, unwrapped.timestamp);
                    break;
                }

                case 0x95: {
                    if (HANDLE_CHAT_PACKET_95) {
                        handleChatPacket95(decodedBuffer, packet.systemAddress);
                    } else {
                        const key = getConnectionKey(packet.systemAddress);
                        logInfo(`[World] CHAT(0x95) skipped handler from ${key} (${decodedBuffer.length} bytes)`);
                    }
                    break;
                }

                default:
                    const addr = addressToString(packet.systemAddress);
                    const wrapper =
                        unwrapped.rawMessageId === RakNetMessageId.ID_TIMESTAMP
                            ? ` (timestamped 0x19 -> 0x${messageId.toString(16).padStart(2, '0')})`
                            : '';
                    logInfo(`[World] Unhandled 0x${messageId.toString(16).padStart(2, '0')} from ${addr} (${packet.length} bytes)${wrapper}`);
                    if (packet.length <= 32) {
                        const hex = Array.from(packet.data)
                            .map((b) => b.toString(16).padStart(2, '0'))
                            .join(' ');
                        logInfo(`         ${hex}`);
                    }
                    break;
            }

            packet = peer.receive();
        }

        await Bun.sleep(10);
    }
}

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
        logInfo(`[World] CHAT(0x95) build reply failed: ${msg}`);
        return null;
    } finally {
        bs?.destroy();
    }
}

function shutdown() {
    logInfo('\n[World] Shutting down...');
    peer.shutdown(500);
    peer.destroy();
    logInfo('[World] Goodbye!');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

mainLoop().catch((err) => {
    const errText = err instanceof Error ? err.stack || err.message : String(err);
    logError(`[World] Fatal error in main loop: ${errText}`);
    peer.shutdown(0);
    peer.destroy();
    process.exit(1);
});
