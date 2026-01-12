/**
 * ID_REGISTER_CLIENT_RETURN (0x79) - World Server -> Client
 * Response to ID_REGISTER_CLIENT (0x78).
 * 
 * Source: Object.lto @ 0x1007a850 (Packet_ID_WORLD_LOGIN_DATA_Ctor)
 *         Object.lto @ 0x1007ab00 (ID_WORLD_LOGIN_DATA_Write)
 * 
 * See: Docs/Notes/ID_REGISTER_CLIENT_RETURN_0x79.md
 */

import { NativeBitStream } from '@openfom/networking';
import { RakNetMessageId } from './shared';
import { Packet } from './base';
import { ProfileA, ProfileB, ProfileC, ProfileD, type ProfileCData } from './structs/profile';
import { CompactVec3, EntryGBlock, TableIBlock, FinalBlock } from './structs/common';

export interface IdRegisterClientReturnData {
    worldId: number;
    worldInst: number;
    returnCode: number;
    appearance?: ProfileCData;
}

export class IdRegisterClientReturnPacket extends Packet {
    static RAKNET_ID = RakNetMessageId.ID_REGISTER_CLIENT_RETURN;

    worldId: number;
    worldInst: number;
    returnCode: number;
    appearance: ProfileCData;

    constructor(data: IdRegisterClientReturnData) {
        super();
        this.worldId = data.worldId;
        this.worldInst = data.worldInst;
        this.returnCode = data.returnCode;
        this.appearance = data.appearance ?? {};
    }

    encode(): Buffer {
        const bs = new NativeBitStream();
        try {
            bs.writeU8(RakNetMessageId.ID_REGISTER_CLIENT_RETURN);
            bs.writeCompressedU8(this.worldId);
            bs.writeCompressedU32(this.worldInst);
            bs.writeCompressedU8(this.returnCode);

            ProfileA.empty().encode(bs);
            ProfileB.empty().encode(bs);
            new ProfileC({ ...this.appearance, hasAbilities: false }).encode(bs);
            new ProfileD(buildDefaultProfileD()).encode(bs);
            this.writeStringBundleE(bs);

            bs.writeCompressedU8(3);
            bs.writeCompressedU8(0);
            bs.writeCompressedU16(0);

            bs.writeBit(true);
            new CompactVec3(0, 0, 0, 0).encode(bs);

            bs.writeCompressedU32(0);
            bs.writeCompressedU32(0);

            bs.writeBit(false);
            bs.writeCompressedU16(0);

            EntryGBlock.empty().encode(bs);
            bs.writeCompressedString('', 2048);
            TableIBlock.empty().encode(bs);
            new CompactVec3(0, 0, 0, 0).encode(bs);

            bs.writeBit(false);
            FinalBlock.empty().encode(bs);

            return bs.getData();
        } finally {
            bs.destroy();
        }
    }

    static decode(_buffer: Buffer): IdRegisterClientReturnPacket {
        throw new Error('IdRegisterClientReturnPacket decode not implemented - server->client only');
    }

    toString(): string {
        return `IdRegisterClientReturnPacket { worldId: ${this.worldId}, worldInst: ${this.worldInst}, returnCode: ${this.returnCode} }`;
    }

    private writeStringBundleE(bs: NativeBitStream): void {
        bs.writeCompressedU32(0);
        bs.writeBit(false);

        bs.writeCompressedString('', 2048);
        bs.writeCompressedString('', 2048);
        bs.writeCompressedString('', 2048);
        bs.writeCompressedString('', 2048);
    }
}

function buildDefaultProfileD(): number[] {
    const stats = Array(53).fill(0);
    // Seed minimal non-zero vitals to avoid "dead" client state.
    stats[0x00] = 1000; // Health (100%)
    stats[0x01] = 1000; // Stamina (100%)
    stats[0x02] = 1000; // Bio Energy (100%)
    stats[0x03] = 1000; // Aura (100%)
    // Basic mobility/regen so the client doesn't feel "stunned".
    stats[0x0b] = 1000; // Agility (100%)
    stats[0x16] = 100;  // Health Regeneration (10%)
    stats[0x17] = 100;  // Stamina Regeneration (10%)
    stats[0x18] = 100;  // Bio Regeneration (10%)
    stats[0x19] = 100;  // Aura Regeneration (10%)
    stats[0x1e] = 0;    // Health Drain
    stats[0x1f] = 0;    // Stamina Drain
    stats[0x20] = 0;    // Bio Energy Drain
    stats[0x21] = 0;    // Aura Drain
    stats[0x27] = 0;    // Weight
    stats[0x28] = 1000; // Jump Velocity Multiplier (100%)
    stats[0x29] = 1000; // Fall Damage Multiplier (100%)
    stats[0x2d] = 1000; // Sprint Speed Multiplier (100%)
    stats[0x2e] = 1000; // Max Stamina (100%)
    return stats;
}
