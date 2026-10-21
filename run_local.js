#!/usr/bin/env node
/**
 * Run the EEPROM_generator pipeline locally (no browser) from an esi.json backup file.
 *
 * Usage: node run_local.js <input-esi.json> <output-dir>
 *
 * Loads the same scripts index.html loads, into one vm context, stubs the few
 * browser APIs touched at load time, then calls the same generator functions
 * the web UI calls from processForm().
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = __dirname
const SCRIPTS = [
  'src/constants.js',
  'src/validation.js',
  'src/od.js',
  'src/file_io.js',
  'src/backup.js',
  'src/binaries.js',
  'src/generators/ecat_options.js',
  'src/generators/EEPROM.js',
  'src/generators/esi_xml.js',
  'src/generators/objectlist.js',
  'src/generators/utypes.js',
]

const noop = () => {}
const sandbox = {
  console,
  Uint8Array, Uint16Array, Uint32Array, Int8Array, ArrayBuffer, DataView,
  TextEncoder, TextDecoder, Math, JSON, Date, Promise, Object, Array, Number,
  String, Boolean, RegExp, Error, Map, Set, parseInt, parseFloat, isNaN,
  setTimeout, clearTimeout,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    documentElement: { setAttribute: noop },
  },
  navigator: { userAgent: 'node' },
  location: { reload: noop, href: '' },
  alert: (m) => console.error('[alert]', m),
  confirm: () => true,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox

const ctx = vm.createContext(sandbox)
for (const rel of SCRIPTS) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  try {
    vm.runInContext(code, ctx, { filename: rel })
  } catch (e) {
    console.error(`!! failed loading ${rel}: ${e.message}`)
    process.exit(1)
  }
}

const [, , inFile, outDir] = process.argv
if (!inFile || !outDir) {
  console.error('usage: node run_local.js <esi.json> <out-dir>')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })

const json = JSON.parse(fs.readFileSync(inFile, 'utf8'))

/** Rebuild the pseudo-<form> object the generators expect from the JSON's form map.
 *  Every generator reads controls by name (form.TextDeviceName.value). */
function buildForm(formValues) {
  const form = {}
  for (const [name, value] of Object.entries(formValues || {})) {
    form[name] = {
      name,
      value: value === true ? 'on' : value === false ? '' : String(value),
      checked: value === true || value === 'true',
      type: typeof value === 'boolean' ? 'checkbox' : 'text',
    }
  }
  return form
}

const form = buildForm(json.form)
// EEPROM.js calls getForm() internally; point the UI hook at our synthetic form.
sandbox.__form = form
vm.runInContext('getForm = () => __form;', ctx)
const od = {
  sdo: (json.od && json.od.sdo) || {},
  txpdo: (json.od && json.od.txpdo) || {},
  rxpdo: (json.od && json.od.rxpdo) || {},
}
const dc = json.dc || []

const g = (name) => {
  const f = vm.runInContext(name, ctx)
  if (typeof f !== 'function') throw new Error(`missing function: ${name}`)
  return f
}

const buildObjectDictionary = g('buildObjectDictionary')
const getUsedIndexes = g('getUsedIndexes')
const objectlist_generator = g('objectlist_generator')
const ecat_options_generator = g('ecat_options_generator')
const utypes_generator = g('utypes_generator')
const hex_generator = g('hex_generator')
const toIntelHex = g('toIntelHex')
const toEsiEepromH = g('toEsiEepromH')
const esi_generator = g('esi_generator')

const objd = buildObjectDictionary(form, od)
const indexes = getUsedIndexes(objd)

const outputs = {
  'objectlist.c': objectlist_generator(form, objd, indexes),
  'ecat_options.h': ecat_options_generator(form, objd, indexes),
  'utypes.h': utypes_generator(form, objd, indexes),
  'esi.xml': esi_generator(form, objd, indexes, dc),
}

const bin = hex_generator(form)
outputs['eeprom.hex'] = toIntelHex(bin)
outputs['eeprom.h'] = toEsiEepromH(bin)

for (const [name, data] of Object.entries(outputs)) {
  if (typeof data === 'string') fs.writeFileSync(path.join(outDir, name), data)
}

if (bin instanceof Uint8Array) {
  fs.writeFileSync(path.join(outDir, 'eeprom.bin'), Buffer.from(bin))
} else if (bin && bin.buffer) {
  fs.writeFileSync(path.join(outDir, 'eeprom.bin'), Buffer.from(bin.buffer))
}

console.log('generated ->', outDir)
for (const name of Object.keys(outputs)) console.log('  ', name)
console.log('   eeprom.bin', bin && bin.length ? `(${bin.length} bytes)` : '(n/a)')
