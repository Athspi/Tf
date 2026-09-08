// worker.js – Ultimate Bitcoin Auto-Sweeper with Telegram Bot
// MERGED: Your working base + Seed Recovery + Master Error Catcher

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

// ============================================================
// KEY & ADDRESS DETECTION
// ============================================================
function isValidAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch {
    try {
      bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
      return true;
    } catch {
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

// ============================================================
// ADDRESS DERIVATION
// ============================================================
function deriveAddressesFromMnemonic(mnemonic, scanDepth = 10) {
  const results = [];
  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed, NETWORK);
    for (const [type, basePath] of Object.entries(PATHS)) {
      for (let i = 0; i < scanDepth; i++) {
        try {
          const child = root.derivePath(`${basePath}/${i}`);
          if (!child.privateKey) continue;
          const privKey = Buffer.from(child.privateKey);
          const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
          const pubkey = Buffer.from(keyPair.publicKey);
          
          let payment;
          if (type === 'legacy') {
            payment = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });
          } else if (type === 'segwit') {
            payment = bitcoin.payments.p2sh({
              redeem: bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }),
              network: NETWORK
            });
          } else {
            payment = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK });
          }
          if (payment.address) {
            results.push({ address: payment.address, keyPair, type, index: i });
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { console.error('Mnemonic derivation error:', e); }
  return results;
}

function deriveAddressesFromXprv(xprvKey, scanDepth = 10) {
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
        if (payment.address) {
          results.push({ address: payment.address, keyPair, type: 'xprv', index: i });
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { console.error('xprv derivation error:', e); }
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

function getAllAddresses(secret, scanDepth = 10) {
  const type = detectKeyType(secret);
  switch (type) {
    case 'mnemonic': return deriveAddressesFromMnemonic(secret, scanDepth);
    case 'xprv': case 'yprv': case 'zprv': case 'tprv':
      return deriveAddressesFromXprv(secret, scanDepth);
    case 'wif': return deriveAddressesFromWif(secret);
    case 'hex': return deriveAddressesFromHex(secret);
    default: return [];
  }
}

// ============================================================
// BLOCKCHAIN API
// ============================================================
async function getUtxos(address) {
  try {
    const resp = await fetch(`${ESPLORA_API}/address/${address}/utxo`);
    if (!resp.ok) return [];
    return resp.json();
  } catch { return []; }
}

async function getTxHex(txid) {
  const resp = await fetch(`${ESPLORA_API}/tx/${txid}/hex`);
  if (!resp.ok) throw new Error(`Failed to get raw tx hex for ${txid}`);
  return resp.text();
}

async function getAddressBalance(address) {
  try {
    const resp = await fetch(`${ESPLORA_API}/address/${address}`);
    if (!resp.ok) return 0;
    const data = await resp.json();
    const funded = data.chain_stats?.funded_txo_sum || 0;
    const spent = data.chain_stats?.spent_txo_sum || 0;
    const memFunded = data.mempool_stats?.funded_txo_sum || 0;
    const memSpent = data.mempool_stats?.spent_txo_sum || 0;
    return (funded - spent) + (memFunded - memSpent);
  } catch { return 0; }
}

async function getAddressTransactions(address, limit = 5) {
  try {
    const resp = await fetch(`${ESPLORA_API}/address/${address}/txs`);
    if (!resp.ok) return [];
    const txs = await resp.json();
    return txs.slice(0, limit);
  } catch { return []; }
}

async function getRecommendedFee() {
  try {
    const resp = await fetch(`${ESPLORA_API}/fee-estimates`);
    if (!resp.ok) return DEFAULT_SAT_PER_BYTE;
    const estimates = await resp.json();
    return Math.ceil(estimates['1'] || estimates['2'] || DEFAULT_SAT_PER_BYTE);
  } catch { return DEFAULT_SAT_PER_BYTE; }
}

function formatTime(timestamp) {
  if (!timestamp) return 'Unconfirmed';
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

function formatBtc(sats) {
  return (sats / 1e8).toFixed(8);
}

// ============================================================
// TRANSACTION BUILDING
// ============================================================
async function createSweepTx(keyPair, utxos, toAddress, feeRate, addrType) {
  const inputCount = utxos.length;
  const estimatedVBytes = inputCount * 180 + 34 + 10;
  const feeSats = estimatedVBytes * feeRate;
  const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);
  const amountToSend = totalInput - feeSats;
  if (amountToSend <= 546) return { error: `Balance ${totalInput} sats too low for fee ${feeSats} sats` };

  const psbt = new bitcoin.Psbt({ network: NETWORK });

  for (const utxo of utxos) {
    const isLegacy = (addrType === 'legacy' || addrType === 'wif' || addrType === 'hex' || addrType === 'xprv');
    
    if (isLegacy) {
      const txHex = await getTxHex(utxo.txid);
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(txHex, 'hex'),
      });
    } else {
      let payment;
      const pubkey = Buffer.from(keyPair.publicKey);
      if (addrType === 'segwit') {
        payment = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }),
          network: NETWORK
        });
      } else { 
        payment = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK });
      }
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: payment.output,
          value: utxo.value,
        },
      });
      if (addrType === 'segwit') {
        psbt.updateInput(psbt.inputCount - 1, { redeemScript: payment.redeem.output });
      }
    }
  }

  psbt.addOutput({ address: toAddress, value: amountToSend });
  
  for (let i = 0; i < utxos.length; i++) {
    const signer = {
      publicKey: Buffer.from(keyPair.publicKey),
      network: keyPair.network,
      sign: (hash, lowR) => Buffer.from(keyPair.sign(hash, lowR))
    };
    psbt.signInput(i, signer);
  }
  
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  
  return { hex: tx.toHex(), amount: amountToSend, fee: feeSats };
}

async function broadcastTx(txHex) {
  const resp = await fetch(`${ESPLORA_API}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Broadcast failed: ${err}`);
  }
  return resp.text();
}

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function sendMsg(botToken, chatId, text, replyMarkup = null) {
  try {
    if (!botToken) return;
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.error('Telegram send error:', e); }
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔑 Import Wallet', callback_data: 'import' }, { text: '🔍 Recover Seed', callback_data: 'recover' }],
      [{ text: '📋 List Wallets', callback_data: 'list' }, { text: '🗑️ Remove Wallet', callback_data: 'remove' }],
      [{ text: '➕ Add Recipient', callback_data: 'addrecipient' }, { text: '📤 Send To Address', callback_data: 'sendto' }],
      [{ text: '🧹 Sweep All', callback_data: 'sweep' }, { text: '📊 Check Balance', callback_data: 'balance' }],
      [{ text: '🔍 Check Transactions', callback_data: 'txs' }],
      [{ text: '⏸️ Pause', callback_data: 'pause' }, { text: '▶️ Resume', callback_data: 'resume' }],
      [{ text: '🧪 Test API', callback_data: 'testapi' }]
    ]
  };
}

// ============================================================
// WALLET STORAGE
// ============================================================
async function getWallets(env, chatId) {
  return (await env.WALLETS.get(`wallets_${chatId}`, 'json')) || [];
}
async function saveWallets(env, chatId, wallets) {
  await env.WALLETS.put(`wallets_${chatId}`, JSON.stringify(wallets));
}
async function getRecipients(env, chatId) {
  return (await env.WALLETS.get(`recipients_${chatId}`, 'json')) || [];
}
async function saveRecipients(env, chatId, recipients) {
  await env.WALLETS.put(`recipients_${chatId}`, JSON.stringify(recipients));
}

// ============================================================
// CORE SWEEP LOGIC
// ============================================================
async function sweepAll(env, chatId, targetAddress = null) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MASTER_ADDRESS,
          MIN_BALANCE_TO_SWEEP = "10000", MAX_FEE_RATE = "50",
          FEE_BUMP = "3", SCAN_DEPTH = "10" } = env;

  const cid = chatId || TELEGRAM_CHAT_ID;
  const dest = targetAddress || MASTER_ADDRESS;
  if (!cid || !dest) return;

  if ((await env.WALLETS.get('PAUSED')) === 'true') {
    await sendMsg(TELEGRAM_BOT_TOKEN, cid, '⏸️ Sweeper is paused.');
    return;
  }

  try {
    const wallets = await getWallets(env, cid);
    if (wallets.length === 0) {
      await sendMsg(TELEGRAM_BOT_TOKEN, cid, '❌ No wallets imported. Use /import.');
      return;
    }

    let report = [], totalSwept = 0;

    for (const wallet of wallets) {
      const secret = wallet.mnemonic || wallet.wif || wallet.hex || wallet.xprv;
      const scanDepth = parseInt(SCAN_DEPTH) || 10;
      const addresses = getAllAddresses(secret, scanDepth);

      for (const addr of addresses) {
        const utxos = await getUtxos(addr.address);
        if (!utxos || utxos.length === 0) continue;

        const balance = utxos.reduce((s, u) => s + u.value, 0);
        if (balance < parseInt(MIN_BALANCE_TO_SWEEP)) continue;

        const feeRate = Math.min(await getRecommendedFee(), parseInt(MAX_FEE_RATE));
        const result = await createSweepTx(addr.keyPair, utxos, dest, feeRate, addr.type);
        if (result.error) {
          report.push(`⚠️ ${wallet.label} (${addr.address}): ${result.error}`);
          continue;
        }

        const txid = await broadcastTx(result.hex);
        report.push(`✅ ${wallet.label} [${addr.type}/${addr.index}]\n   ${addr.address}\n   Sent: ${formatBtc(result.amount)} BTC\n   Tx: <code>${txid}</code>`);
        totalSwept += result.amount;
      }
    }

    if (totalSwept > 0) {
      await sendMsg(TELEGRAM_BOT_TOKEN, cid,
        `🚀 <b>Sweep completed!</b>\n\n${report.join('\n\n')}\n\n💰 Total: ${formatBtc(totalSwept)} BTC → <code>${dest}</code>`);
    } else if (report.length > 0) {
      await sendMsg(TELEGRAM_BOT_TOKEN, cid, `ℹ️ No sweepable balances:\n${report.join('\n')}`);
    } else {
      await sendMsg(TELEGRAM_BOT_TOKEN, cid, 'ℹ️ No funded addresses found in imported wallets.');
    }
  } catch (e) {
    console.error('Sweep error:', e);
    await sendMsg(TELEGRAM_BOT_TOKEN, cid, `❌ Sweep error: ${e.message}`);
  }
}

// ============================================================
// SEED RECOVERY / CANDIDATE ENUMERATOR
// ============================================================
async function recoverSeed(env, chatId, pattern, dictStr) {
  const { TELEGRAM_BOT_TOKEN, MASTER_ADDRESS } = env;
  const dict = dictStr.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
  const words = pattern.toLowerCase().split(/\s+/);
  const wilds = words.map((w, i) => w === '?' ? i : -1).filter(i => i >= 0);

  if (!wilds.length) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ No wildcards (?) found. Use ? for unknown positions.');
    return;
  }
  if (wilds.length > 2 || dict.length > MAX_RECOVERY_ATTEMPTS) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `⚠️ Max 2 wildcards or ${MAX_RECOVERY_ATTEMPTS} words per run.`);
    return;
  }

  const candidates = [];
  let count = 0;
  if (wilds.length === 1) {
    for (const w of dict) {
      const temp = [...words]; temp[wilds[0]] = w;
      candidates.push(temp.join(' '));
      if (++count >= MAX_RECOVERY_ATTEMPTS) break;
    }
  } else {
    for (const w1 of dict) {
      for (const w2 of dict) {
        const temp = [...words]; temp[wilds[0]] = w1; temp[wilds[1]] = w2;
        candidates.push(temp.join(' '));
        if (++count >= MAX_RECOVERY_ATTEMPTS) break;
      }
      if (count >= MAX_RECOVERY_ATTEMPTS) break;
    }
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Scanning ${candidates.length} candidates...`);
  let found = 0;

  for (const mnemonic of candidates) {
    if (!bip39.validateMnemonic(mnemonic)) continue;
    const addrs = deriveAddressesFromMnemonic(mnemonic, 3);
    for (const addr of addrs) {
      const bal = await getAddressBalance(addr.address);
      if (bal > 0) {
        found++;
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `💰 <b>FUNDED!</b>\n📝 <code>${mnemonic}</code>\n📍 ${addr.address}\n💰 ${formatBtc(bal)} BTC\n🚀 Sweeping...`);
        try {
          const utxos = await getUtxos(addr.address);
          const res = await createSweepTx(addr.keyPair, utxos, MASTER_ADDRESS, await getRecommendedFee(), addr.type);
          if (!res.error) await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Swept: <code>${await broadcastTx(res.hex)}</code>`);
        } catch(e) { await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ Sweep failed: ${e.message}`); }
      }
    }
  }
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, found ? `🎉 Found ${found} funded wallet(s)!` : `ℹ️ No funded wallets in ${candidates.length} candidates.`);
}

// ============================================================
// IMPORT WALLET (single key)
// ============================================================
async function importSingleKey(env, chatId, secret) {
  const { TELEGRAM_BOT_TOKEN, SCAN_DEPTH = "10" } = env;
  const keyType = detectKeyType(secret);

  if (keyType === 'unknown' || keyType === 'address') {
    return { success: false, msg: `Skipped (not a valid private key): <code>${secret.substring(0, 20)}...</code>` };
  }

  const scanDepth = parseInt(SCAN_DEPTH) || 10;
  const addresses = getAllAddresses(secret, scanDepth);
  if (addresses.length === 0) {
    return { success: false, msg: `Could not derive addresses from: <code>${secret.substring(0, 20)}...</code>` };
  }

  const wallets = await getWallets(env, chatId);
  const exists = wallets.some(w => (w.mnemonic || w.wif || w.hex || w.xprv) === secret);
  if (exists) {
    return { success: false, msg: `Already imported: <code>${secret.substring(0, 20)}...</code>` };
  }

  const label = `Wallet ${wallets.length + 1}`;
  const walletEntry = { label };
  if (keyType === 'mnemonic') walletEntry.mnemonic = secret;
  else if (keyType === 'wif') walletEntry.wif = secret;
  else if (keyType === 'hex') walletEntry.hex = secret;
  else walletEntry.xprv = secret;

  wallets.push(walletEntry);
  await saveWallets(env, chatId, wallets);

  const firstAddr = addresses[0]?.address || 'N/A';
  return { success: true, msg: `✅ <b>${label}</b> (${keyType})\n   📍 ${firstAddr}\n   📊 ${addresses.length} addresses scanned`, label };
}

// ============================================================
// BULK IMPORT HANDLER
// ============================================================
async function importBulkKeys(env, chatId, text) {
  const { TELEGRAM_BOT_TOKEN } = env;
  const keys = text.split(',').map(k => k.trim()).filter(k => k.length > 0);

  if (keys.length === 0) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ No keys found. Separate keys with commas.');
    return;
  }

  if (keys.length > 50) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Maximum 50 keys per bulk import.');
    return;
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📦 Importing ${keys.length} keys... Please wait.`);

  let successCount = 0, failCount = 0;
  let results = [];

  for (const key of keys) {
    const result = await importSingleKey(env, chatId, key);
    results.push(result.msg);
    if (result.success) successCount++;
    else failCount++;
  }

  const summary = `📦 <b>Bulk Import Complete!</b>\n\n✅ Imported: ${successCount}\n❌ Failed: ${failCount}\n\n${results.join('\n')}`;
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, summary);
}

// ============================================================
// CHECK ADDRESS INFO (balance + transactions)
// ============================================================
async function checkAddressInfo(env, chatId, address, showTxs = false) {
  const { TELEGRAM_BOT_TOKEN } = env;
  if (!isValidAddress(address)) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid Bitcoin address.');
    return;
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Checking <code>${address}</code>...`);

  const balance = await getAddressBalance(address);
  let msg = `📊 <b>Address:</b> <code>${address}</code>\n💰 <b>Balance:</b> ${formatBtc(balance)} 
