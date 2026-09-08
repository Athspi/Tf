// worker.js – Ultimate Bitcoin Auto-Sweeper with Telegram Bot
// FIXED: /balance, /txs, /scan commands, command parsing, error handling

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
  legacy: "m/44'/0'/0'/0",
  segwit: "m/49'/0'/0'/0",
  native: "m/84'/0'/0'/0"
};

// ============================================================
// HELPERS
// ============================================================
function formatBtc(sats) { return (sats / 1e8).toFixed(8); }
function formatTime(ts) { return ts ? new Date(ts * 1000).toISOString().replace('T',' ').substring(0,19)+' UTC' : 'Unconfirmed'; }
function stripCommand(text) { return text.split('@')[0].trim(); }

function isValidAddress(addr) {
  try { bitcoin.address.toOutputScript(addr, NETWORK); return true; } catch {
    try { bitcoin.address.toOutputScript(addr, bitcoin.networks.testnet); return true; } catch { return false; }
  }
}

function detectKeyType(text) {
  const t = text.trim();
  if (!t) return 'unknown';
  if (bip39.validateMnemonic(t)) return 'mnemonic';
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(t)) return 'wif';
  if (/^[0-9a-fA-F]{64}$/.test(t)) return 'hex';
  if (/^[xyzt]prv[1-9A-HJ-NP-Za-km-z]{107}$/.test(t)) return 'xprv';
  if (isValidAddress(t)) return 'address';
  return 'unknown';
}

// ============================================================
// ADDRESS DERIVATION
// ============================================================
function deriveAddressesFromMnemonic(mnemonic, depth = 5) {
  const results = [];
  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed, NETWORK);
    for (const [type, base] of Object.entries(PATHS)) {
      for (let i = 0; i < depth; i++) {
        try {
          const child = root.derivePath(`${base}/${i}`);
          if (!child.privateKey) continue;
          const kp = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: NETWORK });
          const pub = Buffer.from(kp.publicKey);
          let pay;
          if (type === 'legacy') pay = bitcoin.payments.p2pkh({ pubkey: pub, network: NETWORK });
          else if (type === 'segwit') pay = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK }), network: NETWORK });
          else pay = bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK });
          if (pay.address) results.push({ address: pay.address, keyPair: kp, type, index: i });
        } catch {}
      }
    }
  } catch (e) { console.error('Mnemonic error:', e); }
  return results;
}

function deriveAddressesFromWif(wif) {
  try {
    const kp = ECPair.fromWIF(wif);
    const pay = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: kp.network });
    return [{ address: pay.address, keyPair: kp, type: 'wif', index: 0 }];
  } catch { return []; }
}

function deriveAddressesFromHex(hex) {
  try {
    const kp = ECPair.fromPrivateKey(Buffer.from(hex, 'hex'), { network: NETWORK });
    const pay = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: NETWORK });
    return [{ address: pay.address, keyPair: kp, type: 'hex', index: 0 }];
  } catch { return []; }
}

function deriveAddressesFromXprv(xprv, depth = 5) {
  const results = [];
  try {
    const node = bip32.fromBase58(xprv, NETWORK);
    for (let i = 0; i < depth; i++) {
      try {
        const child = node.derive(0).derive(i);
        if (!child.privateKey) continue;
        const kp = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: NETWORK });
        const pay = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: NETWORK });
        if (pay.address) results.push({ address: pay.address, keyPair: kp, type: 'xprv', index: i });
      } catch {}
    }
  } catch {}
  return results;
}

function getAllAddresses(secret, depth = 5) {
  const type = detectKeyType(secret);
  if (type === 'mnemonic') return deriveAddressesFromMnemonic(secret, depth);
  if (type === 'wif') return deriveAddressesFromWif(secret);
  if (type === 'hex') return deriveAddressesFromHex(secret);
  if (type === 'xprv') return deriveAddressesFromXprv(secret, depth);
  return [];
}

// ============================================================
// BLOCKCHAIN API
// ============================================================
async function apiFetch(path) {
  const resp = await fetch(`${ESPLORA_API}${path}`);
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp;
}

async function getUtxos(addr) {
  try { return await (await apiFetch(`/address/${addr}/utxo`)).json(); } catch { return []; }
}

async function getTxHex(txid) {
  return await (await apiFetch(`/tx/${txid}/hex`)).text();
}

async function getAddressBalance(addr) {
  try {
    const d = await (await apiFetch(`/address/${addr}`)).json();
    return ((d.chain_stats?.funded_txo_sum || 0) - (d.chain_stats?.spent_txo_sum || 0)) +
           ((d.mempool_stats?.funded_txo_sum || 0) - (d.mempool_stats?.spent_txo_sum || 0));
  } catch { return 0; }
}

async function getAddressTransactions(addr, limit = 5) {
  try { return (await (await apiFetch(`/address/${addr}/txs`)).json()).slice(0, limit); } catch { return []; }
}

async function getRecommendedFee() {
  try {
    const e = await (await apiFetch('/fee-estimates')).json();
    return Math.ceil(e['1'] || e['2'] || DEFAULT_SAT_PER_BYTE);
  } catch { return DEFAULT_SAT_PER_BYTE; }
}

// ============================================================
// TRANSACTION BUILDING
// ============================================================
async function createSweepTx(keyPair, utxos, toAddr, feeRate, addrType) {
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const fee = (utxos.length * 180 + 44) * feeRate;
  const amount = total - fee;
  if (amount <= 546) return { error: `Balance ${total} sats too low for fee ${fee}` };

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  for (const u of utxos) {
    const isLegacy = ['legacy','wif','hex','xprv'].includes(addrType);
    if (isLegacy) {
      psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(await getTxHex(u.txid), 'hex') });
    } else {
      const pub = Buffer.from(keyPair.publicKey);
      const pay = addrType === 'segwit'
        ? bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK }), network: NETWORK })
        : bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK });
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: pay.output, value: u.value } });
      if (addrType === 'segwit') psbt.updateInput(psbt.inputCount - 1, { redeemScript: pay.redeem.output });
    }
  }
  psbt.addOutput({ address: toAddr, value: amount });
  for (let i = 0; i < utxos.length; i++) {
    psbt.signInput(i, { publicKey: Buffer.from(keyPair.publicKey), network: keyPair.network, sign: (h, l) => Buffer.from(keyPair.sign(h, l)) });
  }
  psbt.finalizeAllInputs();
  return { hex: psbt.extractTransaction().toHex(), amount, fee };
}

async function broadcastTx(hex) {
  const r = await fetch(`${ESPLORA_API}/tx`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: hex });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendMsg(token, chatId, text, kb = null) {
  try {
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb })
    });
  } catch (e) { console.error('TG error:', e); }
}

function mainMenu() {
  return { inline_keyboard: [
    [{ text: '🔑 Import', callback_data: 'import' }, { text: '🔍 Recover', callback_data: 'recover' }],
    [{ text: '📋 List', callback_data: 'list' }, { text: '🗑️ Remove', callback_data: 'remove' }],
    [{ text: '🧹 Sweep All', callback_data: 'sweep' }, { text: '📊 Balance', callback_data: 'balance' }],
    [{ text: '🔍 Transactions', callback_data: 'txs' }, { text: '📤 Send To', callback_data: 'sendto' }],
    [{ text: '➕ Add Recipient', callback_data: 'addrecipient' }],
    [{ text: '⏸️ Pause', callback_data: 'pause' }, { text: '▶️ Resume', callback_data: 'resume' }],
    [{ text: '🧪 Test API', callback_data: 'testapi' }]
  ]};
}

// ============================================================
// STORAGE
// ============================================================
const getWallets = async (env, cid) => (await env.WALLETS.get(`w_${cid}`, 'json')) || [];
const saveWallets = async (env, cid, w) => env.WALLETS.put(`w_${cid}`, JSON.stringify(w));
const getRecipients = async (env, cid) => (await env.WALLETS.get(`r_${cid}`, 'json')) || [];
const saveRecipients = async (env, cid, r) => env.WALLETS.put(`r_${cid}`, JSON.stringify(r));

// ============================================================
// CHECK BALANCE (single address)
// ============================================================
async function checkAddressBalance(env, chatId, addr) {
  const { TELEGRAM_BOT_TOKEN } = env;
  try {
    if (!isValidAddress(addr)) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Invalid address: <code>${addr}</code>`);
      return;
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Checking <code>${addr}</code>...`);
    const bal = await getAddressBalance(addr);
    const utxos = await getUtxos(addr);
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId,
      `📊 <b>Address:</b>\n<code>${addr}</code>\n\n` +
      `💰 <b>Balance:</b> ${formatBtc(bal)} BTC (${bal} sats)\n` +
      `📦 <b>UTXOs:</b> ${utxos.length}`);
  } catch (e) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Error checking balance: ${e.message}`);
  }
}

// ============================================================
// CHECK TRANSACTIONS (single address)
// ============================================================
async function checkAddressTxs(env, chatId, addr) {
  const { TELEGRAM_BOT_TOKEN } = env;
  try {
    if (!isValidAddress(addr)) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Invalid address: <code>${addr}</code>`);
      return;
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Fetching transactions for <code>${addr}</code>...`);
    const bal = await getAddressBalance(addr);
    const txs = await getAddressTransactions(addr, 5);
    let msg = `📊 <b>Address:</b>\n<code>${addr}</code>\n💰 <b>Balance:</b> ${formatBtc(bal)} BTC\n\n`;
    if (txs.length === 0) {
      msg += `📜 No transactions found.`;
    } else {
      msg += `📜 <b>Latest ${txs.length} Transactions:</b>\n`;
      for (const tx of txs) {
        const conf = tx.status?.confirmed ? '✅' : '⏳';
        const time = formatTime(tx.status?.block_time);
        const fee = tx.fee || 0;
        msg += `\n${conf} <code>${tx.txid.substring(0, 20)}...</code>\n   🕐 ${time} | 💸 Fee: ${fee} sats\n`;
      }
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, msg);
  } catch (e) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Error checking transactions: ${e.message}`);
  }
}

// ============================================================
// CHECK ALL WALLETS BALANCE
// ============================================================
async function checkAllBalances(env, chatId) {
  const { TELEGRAM_BOT_TOKEN, SCAN_DEPTH = "5" } = env;
  try {
    const wallets = await getWallets(env, chatId);
    if (!wallets.length) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📭 No wallets imported. Use /import first.');
      return;
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📊 Checking ${wallets.length} wallet(s)...`);
    let msg = '📊 <b>Wallet Balances:</b>\n\n';
    let grand = 0;
    for (const w of wallets) {
      const secret = w.mnemonic || w.wif || w.hex || w.xprv;
      const addrs = getAllAddresses(secret, parseInt(SCAN_DEPTH) || 5);
      let wTotal = 0;
      const funded = [];
      for (const a of addrs) {
        const b = await getAddressBalance(a.address);
        if (b > 0) { wTotal += b; funded.push({ ...a, bal: b }); }
      }
      grand += wTotal;
      msg += `🔹 <b>${w.label}</b>: ${formatBtc(wTotal)} BTC\n`;
      for (const f of funded) msg += `   📍 [${f.type}/${f.index}] <code>${f.address}</code>: ${formatBtc(f.bal)}\n`;
    }
    msg += `\n💰 <b>Grand Total:</b> ${formatBtc(grand)} BTC`;
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, msg);
  } catch (e) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Error: ${e.message}`);
  }
}

// ============================================================
// SWEEP
// ============================================================
async function sweepAll(env, chatId, targetAddr = null) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MASTER_ADDRESS, MIN_BALANCE_TO_SWEEP = "10000", MAX_FEE_RATE = "50" } = env;
  const cid = chatId || TELEGRAM_CHAT_ID;
  const dest = targetAddr || MASTER_ADDRESS;
  if (!cid || !dest) return;
  if ((await env.WALLETS.get('PAUSED')) === 'true') { await sendMsg(TELEGRAM_BOT_TOKEN, cid, '⏸️ Paused.'); return; }

  try {
    const wallets = await getWallets(env, cid);
    if (!wallets.length) { await sendMsg(TELEGRAM_BOT_TOKEN, cid, '❌ No wallets.'); return; }
    let report = [], total = 0;
    for (const w of wallets) {
      for (const a of getAllAddresses(w.mnemonic || w.wif || w.hex || w.xprv)) {
        const utxos = await getUtxos(a.address);
        if (!utxos.length) continue;
        const bal = utxos.reduce((s, u) => s + u.value, 0);
        if (bal < parseInt(MIN_BALANCE_TO_SWEEP)) continue;
        const feeRate = Math.min(await getRecommendedFee(), parseInt(MAX_FEE_RATE));
        const res = await createSweepTx(a.keyPair, utxos, dest, feeRate, a.type);
        if (res.error) { report.push(`⚠️ ${w.label}: ${res.error}`); continue; }
        const txid = await broadcastTx(res.hex);
        report.push(`✅ ${w.label} [${a.type}/${a.index}]\n${a.address}\nSent: ${formatBtc(res.amount)} BTC\nTx: <code>${txid}</code>`);
        total += res.amount;
      }
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, cid, total > 0
      ? `🚀 <b>Sweep done!</b>\n\n${report.join('\n\n')}\n\n💰 Total: ${formatBtc(total)} BTC → <code>${dest}</code>`
      : `ℹ️ ${report.length ? report.join('\n') : 'No funded addresses found.'}`);
  } catch (e) { await sendMsg(TELEGRAM_BOT_TOKEN, cid, `❌ Sweep error: ${e.message}`); }
}

// ============================================================
// SEED RECOVERY
// ============================================================
async function recoverSeed(env, chatId, pattern, dictStr) {
  const { TELEGRAM_BOT_TOKEN, MASTER_ADDRESS } = env;
  const dict = dictStr.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
  const words = pattern.toLowerCase().split(/\s+/);
  const wilds = words.map((w, i) => w === '?' ? i : -1).filter(i => i >= 0);
  if (!wilds.length) { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Use ? for unknown words.'); return; }
  if (wilds.length > 2 || dict.length > MAX_RECOVERY_ATTEMPTS) { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `⚠️ Max 2 wildcards, ${MAX_RECOVERY_ATTEMPTS} words.`); return; }

  const cands = [];
  if (wilds.length === 1) { for (const w of dict) { const t = [...words]; t[wilds[0]] = w; cands.push(t.join(' ')); if (cands.length >= MAX_RECOVERY_ATTEMPTS) break; } }
  else { for (const a of dict) { for (const b of dict) { const t = [...words]; t[wilds[0]] = a; t[wilds[1]] = b; cands.push(t.join(' ')); if (cands.length >= MAX_RECOVERY_ATTEMPTS) break; } if (cands.length >= MAX_RECOVERY_ATTEMPTS) break; } }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Scanning ${cands.length} candidates...`);
  let found = 0;
  for (const m of cands) {
    if (!bip39.validateMnemonic(m)) continue;
    for (const a of deriveAddressesFromMnemonic(m, 3)) {
      const bal = await getAddressBalance(a.address);
      if (bal > 0) {
        found++;
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `💰 <b>FUNDED!</b>\n📝 <code>${m}</code>\n📍 ${a.address}\n💰 ${formatBtc(bal)} BTC\n🚀 Sweeping...`);
        try {
          const utxos = await getUtxos(a.address);
          const res = await createSweepTx(a.keyPair, utxos, MASTER_ADDRESS, await getRecommendedFee(), a.type);
          if (!res.error) await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Swept: <code>${await broadcastTx(res.hex)}</code>`);
        } catch (e) { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Sweep failed: ${e.message}`); }
      }
    }
  }
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, found ? `🎉 Found ${found} funded!` : `ℹ️ No funded in ${cands.length} candidates.`);
}

// ============================================================
// IMPORT
// ============================================================
async function importSingleKey(env, chatId, secret) {
  const type = detectKeyType(secret);
  if (type === 'unknown' || type === 'address') return { ok: false, msg: `Skipped (not a private key)` };
  const addrs = getAllAddresses(secret);
  if (!addrs.length) return { ok: false, msg: `Could not derive addresses` };
  const wallets = await getWallets(env, chatId);
  if (wallets.some(w => (w.mnemonic || w.wif || w.hex || w.xprv) === secret)) return { ok: false, msg: `Already imported` };
  const label = `Wallet ${wallets.length + 1}`;
  const entry = { label };
  if (type === 'mnemonic') entry.mnemonic = secret; else if (type === 'wif') entry.wif = secret;
  else if (type === 'hex') entry.hex = secret; else entry.xprv = secret;
  wallets.push(entry);
  await saveWallets(env, chatId, wallets);
  return { ok: true, msg: `✅ <b>${label}</b> (${type})\n📍 ${addrs[0].address}\n📊 ${addrs.length} addresses` };
}

async function importBulk(env, chatId, text) {
  const { TELEGRAM_BOT_TOKEN } = env;
  const keys = text.split(',').map(k => k.trim()).filter(k => k);
  if (!keys.length) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ No keys.');
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📦 Importing ${keys.length} keys...`);
  let ok = 0, fail = 0;
  for (const k of keys) { const r = await importSingleKey(env, chatId, k); r.ok ? ok++ : fail++; }
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📦 Done: ✅ ${ok} | ❌ ${fail}`);
}

// ============================================================
// MAIN HANDLER
// ============================================================
async function handleUpdate(update, env) {
  const { TELEGRAM_BOT_TOKEN } = env;
  if (!update.message && !update.callback_query) return;
  let chatId, text = '', cb = '';

  if (update.message) { chatId = update.message.chat.id; text = update.message.text || ''; }
  else if (update.callback_query) {
    chatId = update.callback_query.message?.chat?.id || update.callback_query.from.id;
    cb = update.callback_query.data;
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: update.callback_query.id })
    }).catch(() => {});
  }
  if (!chatId) return;

  // BUTTONS
  if (cb) {
    if (cb === 'menu' || cb === 'start') return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🤖 <b>Bitcoin Sweeper</b>', mainMenu());
    if (cb === 'import') return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🔑 Send mnemonic, WIF, Hex, xprv.\nBulk: <code>key1,key2,key3</code>');
    if (cb === 'recover') return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🔍 Syntax: /recover <pattern with ?> <word1,word2>');
    if (cb === 'list') { const w = await getWallets(env, chatId); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, w.length ? '📋 ' + w.map(x => `🔹 ${x.label}`).join('\n') : '📭 None.'); }
    if (cb === 'remove') { const w = await getWallets(env, chatId); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, w.length ? 'Select:' : '📭', { inline_keyboard: w.map((x, i) => [{ text: `🗑️ ${x.label}`, callback_data: `del_${i}` }]) }); }
    if (cb === 'sweep') { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🧹 Sweeping...'); return await sweepAll(env, chatId); }
    if (cb === 'balance') { return await checkAllBalances(env, chatId); }
    if (cb === 'txs') { return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🔍 Send /txs <address>'); }
    if (cb === 'addrecipient') { return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '➕ Send a BTC address or use /add <addr>'); }
    if (cb === 'sendto') { const r = await getRecipients(env, chatId); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, r.length ? 'Select:' : 'None. /add <addr>', { inline_keyboard: r.map((x, i) => [{ text: x.substring(0, 20) + '...', callback_data: `send_${i}` }]) }); }
    if (cb === 'pause') { await env.WALLETS.put('PAUSED', 'true'); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⏸️ Paused.'); }
    if (cb === 'resume') { await env.WALLETS.put('PAUSED', 'false'); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '▶️ Resumed.'); }
    if (cb === 'testapi') { try { return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🧪 OK | Fee: ${await getRecommendedFee()} sat/vB`); } catch (e) { return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ ${e.message}`); } }
    if (cb.startsWith('del_')) { const i = +cb.split('_')[1], w = await getWallets(env, chatId); if (i < w.length) { const rm = w.splice(i, 1)[0]; await saveWallets(env, chatId, w); await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🗑️ Removed ${rm.label}`); } return; }
    if (cb.startsWith('send_')) { const i = +cb.split('_')[1], r = await getRecipients(env, chatId); if (i < r.length) { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📤 Sweeping to ${r[i]}...`); await sweepAll(env, chatId, r[i]); } return; }
    return;
  }

  // TEXT COMMANDS (strip @BotName)
  const t = text.trim();
  const cmd = stripCommand(t.split(' ')[0]);
  const args = t.split(' ').slice(1);

  if (cmd === '/start' || cmd === '/menu') return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🤖 <b>Bitcoin Sweeper</b>', mainMenu());

  // /balance [address]
  if (cmd === '/balance') {
    if (args.length > 0) return await checkAddressBalance(env, chatId, args[0]);
    return await checkAllBalances(env, chatId);
  }

  // /txs <address> or /scan <address>
  if (cmd === '/txs' || cmd === '/scan') {
    if (args.length > 0) return await checkAddressTxs(env, chatId, args[0]);
    return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `Usage: ${cmd} <bitcoin_address>`);
  }

  // /recover <pattern> <dict>
  if (cmd === '/recover') {
    if (args.length < 2) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /recover <pattern with ?> <word1,word2>');
    const dict = args.pop();
    const pattern = args.join(' ');
    if (env.ctx) env.ctx.waitUntil(recoverSeed(env, chatId, pattern, dict));
    else await recoverSeed(env, chatId, pattern, dict);
    return;
  }

  if (cmd === '/sweep') { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🧹 Sweeping...'); return await sweepAll(env, chatId); }
  if (cmd === '/pause') { await env.WALLETS.put('PAUSED', 'true'); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⏸️'); }
  if (cmd === '/resume') { await env.WALLETS.put('PAUSED', 'false'); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '▶️'); }
  if (cmd === '/list') { const w = await getWallets(env, chatId); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, w.length ? w.map(x => `🔹 ${x.label}`).join('\n') : '📭'); }
  if (cmd === '/recipients') { const r = await getRecipients(env, chatId); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, r.length ? r.map(x => `<code>${x}</code>`).join('\n') : '📭'); }

  if (cmd === '/add') {
    const a = args[0];
    if (!a || !isValidAddress(a)) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid. /add <addr>');
    const r = await getRecipients(env, chatId);
    if (r.includes(a)) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Exists.');
    r.push(a); await saveRecipients(env, chatId, r);
    return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Added <code>${a}</code>`);
  }

  if (cmd === '/remove') {
    const a = args[0]; const r = await getRecipients(env, chatId); const i = r.indexOf(a);
    if (i === -1) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Not found.');
    r.splice(i, 1); await saveRecipients(env, chatId, r);
    return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🗑️ Removed <code>${a}</code>`);
  }

  if (cmd === '/send') {
    const a = args[0];
    if (!a || !isValidAddress(a)) return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ /send <addr>');
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📤 Sweeping to <code>${a}</code>...`);
    return await sweepAll(env, chatId, a);
  }

  // Bulk import (comma separated)
  if (t.includes(',')) return await importBulk(env, chatId, t);

  // Single key / address
  const type = detectKeyType(t);
  if (['mnemonic', 'wif', 'hex', 'xprv'].includes(type)) {
    const r = await importSingleKey(env, chatId, t);
    return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, r.msg);
  }
  if (type === 'address') {
    const r = await getRecipients(env, chatId);
    if (!r.includes(t)) { r.push(t); await saveRecipients(env, chatId, r); return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Added <code>${t}</code>`); }
    return await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Exists.');
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❓ Use /start', mainMenu());
}

// ============================================================
// EXPORT
// ============================================================
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(sweepAll(env, env.TELEGRAM_CHAT_ID)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
      env.ctx = ctx;
      ctx.waitUntil(handleUpdate(await request.json(), env));
      return new Response('OK');
    }
    if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    if (request.method === 'POST' && url.pathname === '/sweep') {
      ctx.waitUntil(sweepAll(env, url.searchParams.get('chatId') || env.TELEGRAM_CHAT_ID, url.searchParams.get('to')));
      return new Response('OK');
    }
    return new Response('Not found', { status: 404 });
  }
};
