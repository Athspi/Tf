// worker.js – Ultimate Bitcoin Auto-Sweeper with Telegram Bot
// Features: All key formats, bulk import, tx history, balance check, Trust Wallet scanning

import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
const NETWORK = bitcoin.networks.bitcoin;
const DEFAULT_SAT_PER_BYTE = 15;
const ESPLORA_API = 'https://blockstream.info/api';

const PATHS = {
  legacy:  "m/44'/0'/0'/0",
  segwit:  "m/49'/0'/0'/0",
  native:  "m/84'/0'/0'/0"
};

// ============================================================
// KEY DETECTION
// ============================================================
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
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(t)) return 'address_legacy';
  if (/^bc1q[a-zA-HJ-NP-Z0-9]{38,58}$/.test(t)) return 'address_segwit';
  if (/^bc1p[a-zA-HJ-NP-Z0-9]{58}$/.test(t)) return 'address_taproot';
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
          const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: NETWORK });
          let payment;
          if (type === 'legacy') {
            payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
          } else if (type === 'segwit') {
            payment = bitcoin.payments.p2sh({
              redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK }),
              network: NETWORK
            });
          } else {
            payment = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK });
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
        const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: NETWORK });
        const payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
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
    const keyPair = ECPair.fromWIF(wif, NETWORK);
    const payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
    return [{ address: payment.address, keyPair, type: 'wif', index: 0 }];
  } catch (e) { console.error('WIF error:', e); return []; }
}

function deriveAddressesFromHex(hex) {
  try {
    const keyPair = ECPair.fromPrivateKey(Buffer.from(hex, 'hex'), { network: NETWORK });
    const payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
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
async function createSweepTx(keyPair, utxos, toAddress, feeRate) {
  const inputCount = utxos.length;
  const estimatedVBytes = inputCount * 180 + 34 + 10;
  const feeSats = estimatedVBytes * feeRate;
  const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);
  const amountToSend = totalInput - feeSats;
  if (amountToSend <= 546) return { error: `Balance ${totalInput} sats too low for fee ${feeSats} sats` };

  const txb = new bitcoin.TransactionBuilder(NETWORK);
  utxos.forEach(utxo => {
    txb.addInput(utxo.txid, utxo.vout);
    txb.setInputSequence(txb.inputs.length - 1, 0xfffffffd);
  });
  txb.addOutput(toAddress, amountToSend);
  utxos.forEach((_, i) => txb.sign(i, keyPair));

  return { hex: txb.build().toHex(), amount: amountToSend, fee: feeSats };
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
      [{ text: '🔑 Import Wallet', callback_data: 'import' }],
      [{ text: '📋 List Wallets', callback_data: 'list' }],
      [{ text: '🗑️ Remove Wallet', callback_data: 'remove' }],
      [{ text: '➕ Add Recipient', callback_data: 'addrecipient' }],
      [{ text: '📤 Send To Address', callback_data: 'sendto' }],
      [{ text: '🧹 Sweep All', callback_data: 'sweep' }],
      [{ text: '📊 Check Balance', callback_data: 'balance' }],
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
        const result = await createSweepTx(addr.keyPair, utxos, dest, feeRate);
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
// IMPORT WALLET (single key)
// ============================================================
async function importSingleKey(env, chatId, secret) {
  const { TELEGRAM_BOT_TOKEN, SCAN_DEPTH = "10" } = env;
  const keyType = detectKeyType(secret);

  if (keyType === 'unknown' || keyType.startsWith('address')) {
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
  const type = detectKeyType(address);
  if (!type.startsWith('address')) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid Bitcoin address.');
    return;
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🔍 Checking <code>${address}</code>...`);

  const balance = await getAddressBalance(address);
  let msg = `📊 <b>Address:</b> <code>${address}</code>\n💰 <b>Balance:</b> ${formatBtc(balance)} BTC (${balance} sats)\n`;

  if (showTxs) {
    const txs = await getAddressTransactions(address, 5);
    if (txs.length > 0) {
      msg += `\n📜 <b>Latest Transactions:</b>\n`;
      for (const tx of txs) {
        const time = formatTime(tx.status?.block_time);
        const confirmed = tx.status?.confirmed ? '✅' : '⏳';
        const fee = tx.fee || 0;
        msg += `\n${confirmed} <code>${tx.txid.substring(0, 16)}...</code>\n   🕐 ${time}\n   💸 Fee: ${fee} sats\n`;
      }
    } else {
      msg += `\n📜 No transactions found.`;
    }
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, msg);
}

// ============================================================
// CHECK ALL WALLET BALANCES
// ============================================================
async function checkAllBalances(env, chatId) {
  const { TELEGRAM_BOT_TOKEN, SCAN_DEPTH = "10" } = env;
  const wallets = await getWallets(env, chatId);

  if (wallets.length === 0) {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📭 No wallets imported.');
    return;
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📊 Checking all wallet balances...');

  let msg = '📊 <b>Wallet Balances:</b>\n\n';
  let grandTotal = 0;

  for (const w of wallets) {
    const secret = w.mnemonic || w.wif || w.hex || w.xprv;
    const scanDepth = parseInt(SCAN_DEPTH) || 10;
    const addrs = getAllAddresses(secret, scanDepth);
    let walletTotal = 0;
    let fundedAddrs = [];

    for (const a of addrs) {
      const bal = await getAddressBalance(a.address);
      if (bal > 0) {
        walletTotal += bal;
        fundedAddrs.push({ addr: a.address, bal, type: a.type, index: a.index });
      }
    }

    grandTotal += walletTotal;
    msg += `🔹 <b>${w.label}</b>: ${formatBtc(walletTotal)} BTC\n`;
    for (const fa of fundedAddrs) {
      msg += `   📍 [${fa.type}/${fa.index}] <code>${fa.addr}</code>: ${formatBtc(fa.bal)} BTC\n`;
    }
  }

  msg += `\n💰 <b>Grand Total:</b> ${formatBtc(grandTotal)} BTC`;
  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, msg);
}

// ============================================================
// TELEGRAM BOT HANDLER
// ============================================================
async function handleTelegramUpdate(update, env) {
  const { TELEGRAM_BOT_TOKEN } = env;
  if (!update.message && !update.callback_query) return;

  let chatId, text = '', callbackData;

  if (update.message) {
    chatId = update.message.chat.id;
    text = update.message.text || '';
  } else if (update.callback_query) {
    chatId = update.callback_query.message?.chat?.id || update.callback_query.from.id;
    callbackData = update.callback_query.data;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: update.callback_query.id })
    });
  }
  if (!chatId) return;

  // ---- BUTTON HANDLERS ----
  if (callbackData) {
    switch (callbackData) {
      case 'menu': case 'start':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🤖 <b>Bitcoin Sweeper Bot</b>\n\nChoose an action:', mainMenuKeyboard());
        break;
      case 'import':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId,
          '🔑 Send me your key(s):\n\n' +
          '<b>Single key:</b>\n• 12/24 word mnemonic\n• WIF (K/L/5/c/9)\n• Hex (64 chars)\n• xprv / yprv / zprv\n\n' +
          '<b>Bulk import:</b>\nSeparate keys with commas:\n<code>key1,key2,key3</code>\n\n' +
          'I scan multiple addresses like Trust Wallet.');
        break;
      case 'list': {
        const wallets = await getWallets(env, chatId);
        if (wallets.length === 0) {
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📭 No wallets imported.');
        } else {
          let msg = '📋 <b>Your Wallets:</b>\n\n';
          for (const w of wallets) msg += `🔹 <b>${w.label}</b>\n`;
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, msg);
        }
        break;
      }
      case 'remove': {
        const wallets = await getWallets(env, chatId);
        if (wallets.length === 0) {
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📭 No wallets to remove.');
        } else {
          const kb = wallets.map((w, i) => [{ text: `🗑️ ${w.label}`, callback_data: `del_${i}` }]);
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Select wallet to remove:', { inline_keyboard: kb });
        }
        break;
      }
      case 'addrecipient':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '➕ Send me a Bitcoin address.\nExample: <code>bc1q...</code>');
        break;
      case 'sendto': {
        const recipients = await getRecipients(env, chatId);
        if (recipients.length === 0) {
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'No recipients yet. Add with /add <address>');
        } else {
          const kb = recipients.map((r, i) => [{ text: r.substring(0, 20) + '...', callback_data: `send_${i}` }]);
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Select recipient to sweep to:', { inline_keyboard: kb });
        }
        break;
      }
      case 'sweep':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🧹 Sweeping all wallets to MASTER_ADDRESS...');
        await sweepAll(env, chatId);
        break;
      case 'balance':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📊 Send /balance to check all wallets.\nOr /balance <address> for a specific address.');
        break;
      case 'txs':
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🔍 Send /txs <address> to check latest transactions.');
        break;
      case 'pause':
        await env.WALLETS.put('PAUSED', 'true');
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⏸️ Sweeper paused.');
        break;
      case 'resume':
        await env.WALLETS.put('PAUSED', 'false');
        await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '▶️ Sweeper resumed.');
        break;
      case 'testapi': {
        try {
          const fee = await getRecommendedFee();
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🧪 <b>API OK</b>\n💸 Fee: ${fee} sat/vB`);
        } catch (e) {
          await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `❌ API failed: ${e.message}`);
        }
        break;
      }
      default: {
        if (callbackData.startsWith('del_')) {
          const idx = parseInt(callbackData.split('_')[1]);
          const wallets = await getWallets(env, chatId);
          if (idx >= 0 && idx < wallets.length) {
            const removed = wallets.splice(idx, 1)[0];
            await saveWallets(env, chatId, wallets);
            await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🗑️ Removed <b>${removed.label}</b>`);
          }
        } else if (callbackData.startsWith('send_')) {
          const idx = parseInt(callbackData.split('_')[1]);
          const recipients = await getRecipients(env, chatId);
          if (idx >= 0 && idx < recipients.length) {
            await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📤 Sweeping to <code>${recipients[idx]}</code>...`);
            await sweepAll(env, chatId, recipients[idx]);
          }
        }
      }
    }
    return;
  }

  // ---- TEXT COMMANDS ----
  const trimmed = text.trim();
  if (trimmed === '/start' || trimmed.startsWith('/start') || trimmed === '/menu') {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🤖 <b>Bitcoin Sweeper Bot</b>\n\nChoose an action:', mainMenuKeyboard());
    return;
  }

  // /balance <address> or /balance (all wallets)
  if (trimmed === '/balance') {
    await checkAllBalances(env, chatId);
    return;
  }
  if (trimmed.startsWith('/balance')) {
    const parts = trimmed.split(' ');
    if (parts.length > 1) {
      await checkAddressInfo(env, chatId, parts[1], false);
    } else {
      await checkAllBalances(env, chatId);
    }
    return;
  }

  // /txs <address> - check latest transactions
  if (trimmed.startsWith('/txs')) {
    const parts = trimmed.split(' ');
    if (parts.length > 1) {
      await checkAddressInfo(env, chatId, parts[1], true);
    } else {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /txs <bitcoin_address>');
    }
    return;
  }

  // /scan <address> - full scan (balance + txs)
  if (trimmed.startsWith('/scan')) {
    const parts = trimmed.split(' ');
    if (parts.length > 1) {
      await checkAddressInfo(env, chatId, parts[1], true);
    } else {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /scan <bitcoin_address>');
    }
    return;
  }

  // /add <address>
  if (trimmed.startsWith('/add')) {
    const parts = trimmed.split(' ');
    if (parts.length < 2) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /add <bitcoin_address>');
      return;
    }
    const addr = parts[1];
    const type = detectKeyType(addr);
    if (!type.startsWith('address')) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid Bitcoin address.');
      return;
    }
    const recipients = await getRecipients(env, chatId);
    if (recipients.includes(addr)) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Already in recipient list.');
    } else {
      recipients.push(addr);
      await saveRecipients(env, chatId, recipients);
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Recipient added: <code>${addr}</code>`);
    }
    return;
  }

  // /remove <address>
  if (trimmed.startsWith('/remove')) {
    const parts = trimmed.split(' ');
    if (parts.length < 2) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /remove <bitcoin_address>');
      return;
    }
    const addr = parts[1];
    const recipients = await getRecipients(env, chatId);
    const idx = recipients.indexOf(addr);
    if (idx === -1) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Address not found.');
    } else {
      recipients.splice(idx, 1);
      await saveRecipients(env, chatId, recipients);
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `🗑️ Removed: <code>${addr}</code>`);
    }
    return;
  }

  // /recipients
  if (trimmed === '/recipients') {
    const recipients = await getRecipients(env, chatId);
    if (recipients.length === 0) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📭 No recipients.');
    } else {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '📤 <b>Recipients:</b>\n' + recipients.map(r => `<code>${r}</code>`).join('\n'));
    }
    return;
  }

  // /send <address>
  if (trimmed.startsWith('/send')) {
    const parts = trimmed.split(' ');
    if (parts.length < 2) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, 'Usage: /send <bitcoin_address>');
      return;
    }
    const addr = parts[1];
    const type = detectKeyType(addr);
    if (!type.startsWith('address')) {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid address.');
      return;
    }
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `📤 Sweeping to <code>${addr}</code>...`);
    await sweepAll(env, chatId, addr);
    return;
  }

  // /sweep
  if (trimmed === '/sweep') {
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '🧹 Sweeping all wallets...');
    await sweepAll(env, chatId);
    return;
  }

  if (trimmed === '/pause') { await env.WALLETS.put('PAUSED', 'true'); await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⏸️ Paused.'); return; }
  if (trimmed === '/resume') { await env.WALLETS.put('PAUSED', 'false'); await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '▶️ Resumed.'); return; }
  if (trimmed === '/list') {
    const wallets = await getWallets(env, chatId);
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, wallets.length ? wallets.map(w => `🔹 ${w.label}`).join('\n') : '📭 No wallets.');
    return;
  }

  // ---- BULK KEY DETECTION (comma separated) ----
  if (trimmed.includes(',')) {
    await importBulkKeys(env, chatId, trimmed);
    return;
  }

  // ---- SINGLE KEY / ADDRESS INPUT ----
  const keyType = detectKeyType(trimmed);
  if (keyType === 'mnemonic' || keyType === 'wif' || keyType === 'hex' ||
      keyType === 'xprv' || keyType === 'yprv' || keyType === 'zprv' || keyType === 'tprv') {
    const result = await importSingleKey(env, chatId, trimmed);
    await sendMsg(TELEGRAM_BOT_TOKEN, chatId, result.msg);
    return;
  }

  if (keyType.startsWith('address')) {
    const recipients = await getRecipients(env, chatId);
    if (!recipients.includes(trimmed)) {
      recipients.push(trimmed);
      await saveRecipients(env, chatId, recipients);
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, `✅ Recipient added: <code>${trimmed}</code>`);
    } else {
      await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Already in list.');
    }
    return;
  }

  await sendMsg(TELEGRAM_BOT_TOKEN, chatId, '❓ Not understood. Use /start for menu.', mainMenuKeyboard());
}

// ============================================================
// WORKER EXPORT
// ============================================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepAll(env, env.TELEGRAM_CHAT_ID));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/telegram-webhook') {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response('OK');
    }

    if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method === 'POST' && pathname === '/sweep') {
      const chatId = url.searchParams.get('chatId') || env.TELEGRAM_CHAT_ID;
      const to = url.searchParams.get('to') || null;
      ctx.waitUntil(sweepAll(env, chatId, to));
      return new Response('Sweep triggered');
    }
    if (request.method === 'POST' && pathname === '/pause') {
      await env.WALLETS.put('PAUSED', 'true');
      return new Response('Paused');
    }
    if (request.method === 'POST' && pathname === '/resume') {
      await env.WALLETS.put('PAUSED', 'false');
      return new Response('Resumed');
    }

    return new Response('Not found', { status: 404 });
  }
};
