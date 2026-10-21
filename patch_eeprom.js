#!/usr/bin/env node
/**
 * Patch an EtherCAT SII EEPROM image so PDO mapping is actually described.
 *
 * The EEPROM_generator (kubabuda) only emits Strings / General / FMMU / SyncManager
 * categories and hardcodes SM2/SM3 length to 0. It never writes RxPDO (0x33),
 * TxPDO (0x32) nor the PDO assignment categories (0x2A/0x2B). This script appends
 * them, sets the SM2/SM3 lengths and fixes the word-0 area checksum.
 *
 * Usage: node patch_eeprom.js <in.bin> <out.bin>
 */
'use strict'

const fs = require('fs')

const [inFile, outFile] = process.argv.slice(2)
if (!inFile || !outFile) {
  console.error('usage: node patch_eeprom.js <in.bin> <out.bin>')
  process.exit(2)
}

const img = Buffer.from(fs.readFileSync(inFile))
const W = (o) => img[o] | (img[o + 1] << 8)
const setW = (o, v) => { img[o] = v & 0xff; img[o + 1] = (v >> 8) & 0xff }

// ---------------------------------------------------------------- PDO content
// Object dictionary as declared in Core/Ethercat/objectlist.c + utypes.h:
//   0x6000 fb_position, 0x6001 fb_speed  (TxPDO, RO)
//   0x7000 cmd_position, 0x7001 cmd_speed (RxPDO, RW)
// utypes.h declares each as `uint8_t name[1]`, so the valid mapping subindex is 1.
//
// SII PDO record layout as consumed by masters (SOEM ecx_siiPDO):
//
//   per PDO record:  index(2) | nEntries(1) | syncManager(1) | pad(4)
//   per entry:       index(2) | subindex(1) | pad(2) | bitLength(1) | pad(2)
//
// The parser does, per record:  read index word, read nEntries byte,
// read SM byte, skip 4 bytes; then per entry: skip 5 bytes, read bit
// length byte, skip 2 bytes.  So an entry is 8 bytes and the bit length
// sits at offset +5 with *no* separate maxSubindex word.
//
// (ETG1000.6 Table 26/27. Do NOT confuse with the PDO *assignment* category,
//  which stores only the 16-bit PDO index per entry.)
const PDO_ENTRY_BYTES = 8
const PDO_RECORD_HDR = 8 // index(2) + nEntries(1) + sm(1) + pad(4)
const pdoEntry = (index, sub, bits) => ({ index, sub, bits })

// SM index each PDO is mapped onto (SM2 = outputs, SM3 = inputs)
const SM_RX = 2
const SM_TX = 3

const rxRecords = [
  { index: 0x1400, sm: SM_RX, entries: [pdoEntry(0x7000, 0x01, 8)] }, // cmd_position
  { index: 0x1401, sm: SM_RX, entries: [pdoEntry(0x7001, 0x01, 8)] }, // cmd_speed
]
const txRecords = [
  { index: 0x1A00, sm: SM_TX, entries: [pdoEntry(0x6000, 0x01, 8)] }, // fb_position
  { index: 0x1A01, sm: SM_TX, entries: [pdoEntry(0x6001, 0x01, 8)] }, // fb_speed
]
const rxTotalBytes = rxRecords.length * 1 // one UNSIGNED8 per record
const txTotalBytes = txRecords.length * 1

// -------------------------------------------------------------- walk category
let ptr = 0x80
while (ptr + 4 <= img.length) {
  const type = W(ptr)
  const size = W(ptr + 2)
  if (type === 0xffff || size === 0) break
  ptr += 4 + size * 2
}
const siiEnd = ptr
console.log(`existing SII ends at 0x${siiEnd.toString(16)}`)

let off = siiEnd

// ------------------------------------------------------- category 0x33 RxPDO
off = writePdoCategory(0x33, rxRecords, off)
// ------------------------------------------------------- category 0x32 TxPDO
off = writePdoCategory(0x32, txRecords, off)
// ------------------------------------------------- category 0x2B RxPDO assign
off = writeAssignCategory(0x2B, rxRecords.map(r => r.index), off)
// ------------------------------------------------- category 0x2A TxPDO assign
off = writeAssignCategory(0x2A, txRecords.map(r => r.index), off)

console.log(`new SII ends at 0x${off.toString(16)}`)

// --------------------------------------------------- fix SM2/SM3 lengths
// SyncManager category starts at 0xd4: 4 header bytes then 4 entries of 8 bytes.
// SM2 entry @0xe8, SM3 entry @0xf0.
const smCat = findCategory(0x29)
if (smCat < 0) throw new Error('SyncManager category not found')
const sm2 = smCat + 4 + 2 * 8
const sm3 = smCat + 4 + 3 * 8
setW(sm2 + 2, rxTotalBytes)
setW(sm3 + 2, txTotalBytes)
console.log(`SM2 len -> ${rxTotalBytes}, SM3 len -> ${txTotalBytes}`)

// ------------------------------------------------- fix word-0 area checksum
// word 0 low byte = EEPROM size/128 - 1, high byte = checksum over words 0..6
// such that the byte sum of words 0..7 including checksum is 0.
fixConfigChecksum()

fs.writeFileSync(outFile, img)
console.log(`written ${outFile} (${img.length} bytes)`)

// ------------------------------------------------------------------ helpers
function writePdoCategory(catType, records, o) {
  const words = records.reduce(
    (a, r) => a + PDO_RECORD_HDR / 2 + (r.entries.length * PDO_ENTRY_BYTES) / 2, 0)
  setW(o, catType); o += 2
  setW(o, words); o += 2
  for (const r of records) {
    setW(o, r.index); o += 2        // off 0..1  PDO index
    img[o++] = r.entries.length     // off 2     number of mapping entries
    img[o++] = r.sm                 // off 3     sync manager index
    img[o++] = 0; img[o++] = 0      // off 4..5  pad
    img[o++] = 0; img[o++] = 0      // off 6..7  pad
    for (const e of r.entries) o = writePdoEntry(e, o)
  }
  return o
}

// 8-byte mapping entry, bit length at offset +5 (see layout note above)
function writePdoEntry(e, o) {
  setW(o, e.index); o += 2   // off 0..1 object index
  img[o++] = e.sub & 0xff    // off 2    subindex
  img[o++] = 0               // off 3    pad
  img[o++] = 0               // off 4    pad
  img[o++] = e.bits & 0xff   // off 5    bit length
  img[o++] = 0               // off 6    pad
  img[o++] = 0               // off 7    pad
  return o
}

function writeAssignCategory(catType, indexes, o) {
  setW(o, catType); o += 2
  setW(o, 1 + indexes.length); o += 2 // count word + one word per index
  setW(o, indexes.length); o += 2
  for (const i of indexes) { setW(o, i); o += 2 }
  return o
}

function findCategory(type) {
  let p = 0x80
  while (p + 4 <= img.length) {
    const t = W(p), s = W(p + 2)
    if (t === 0xffff || s === 0) return -1
    if (t === type) return p
    p += 4 + s * 2
  }
  return -1
}

function fixConfigChecksum() {
  // ETG1000.6: word 7 low byte holds a CRC-8 over bytes 0..13, i.e. the first
  // 7 words (word 0 = PDI control, word 1 = PDI config, words 2..3 alias,
  // words 4..6 reserved, word 7 = checksum).
  //
  // CRC-8, polynomial 0x07, init 0xFF, MSB-first, byte XORed in *before* the
  // 8 shifts. This is exactly SOEM's calc_crc()/SIIcrc() in
  // samples/eepromtool/eepromtool.c -- verified against hardware.
  //
  // NOTE: this is NOT a plain byte sum. An earlier version of this script used
  // a byte-sum and also wrote to img[1] (word 0 high byte), which corrupted
  // PDI Control and left the real checksum word untouched.
  img[14] = 0
  img[15] = 0
  let crc = 0xff
  for (let i = 0; i < 14; i++) {
    crc ^= img[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? (((crc << 1) ^ 0x07) & 0xff) : ((crc << 1) & 0xff)
    }
  }
  img[14] = crc
  console.log(`word7 checksum -> 0x${crc.toString(16).padStart(2, '0')}, word7 = 0x${W(14).toString(16).padStart(4, '0')}`)
}
