// worker.js – Bitcoin Auto-Sweeper with Telegram Bot
// Local npm packages

import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import bip32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

const bip32 = bip32Factory(ecc);
const NETWORK = bitcoin.networks.bitcoin;
const DEFAULT_SAT_PER_BYTE = 15;

const ESPLORA_API = 'https://blockstream.info/api';

const PATHS = {
  legacy: "m/44'/0'/0'/0/0",
  segwit: "m/49'/0'/0'/0/0",
  native: "m/84'/0'/0'/0/0"
};

function deriveKeyPairFromMnemonic(mnemonic, path) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);
  const child = root.derivePath(path);
  return bitcoin.ECPair.fromPrivateKey(child.privateKey, { network: NETWORK });
}

function getAddressAndKeyPair(mnemonic, type) {
  const keyPair = deriveKeyPairFromMnemonic(mnemonic, PATHS[type]);
  let payment;
  if (type === 'legacy') {
    payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
  } else if (type === 'segwit') {
    payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK }),
      network: NETWORK
    });
  } else if (type === 'native') {
    payment = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK });
  }
  return { address: payment.address, keyPair };
}

function getAllSourceAddresses(mnemonic) {
  return ['legacy', 'segwit', 'native'].map(type => {
    const { address, keyPair } = getAddressAndKeyPair(mnemonic, type);
    return { address, keyPair, type };
  });
}

async function getUtxos(address) {
  const url = `${ESPLORA_API}/address/${address}/utxo`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`UTXO fetch failed: ${resp.status}`);
  return resp.json();
}

async function getMempoolTxs(address) {
  const url = `${ESPLORA_API}/address/${address}/txs/mempool`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  return resp.json();
}

async function getTxDetails(txid) {
  const url = `${ESPLORA_API}/tx/${txid}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json();
}

async function getFeeEstimates() {
  const url = `${ESPLORA_API}/fee-estimates`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fee estimate failed: ${resp.status}`);
  return resp.json();
}

async function getRecommendedFee() {
  try {
    const estimates = await getFeeEstimates();
    const fastest = estimates['1'] || estimates['2'] || DEFAULT_SAT_PER_BYTE;
    return Math.ceil(fastest);
  } catch (e) {
    console.error('Fee estimate error:', e);
    return DEFAULT_SAT_PER_BYTE;
  }
}

async function getHighestCompetitorFee(address) {
  try {
    const mempoolTxs = await getMempoolTxs(address);
    if (!mempoolTxs || mempoolTxs.length === 0) return 0;
    let maxFeeRate = 0;
    for (const txid of mempoolTxs) {
      const txDetails = await getTxDetails(txid);
      if (txDetails && txDetails.fee && txDetails.weight) {
        const vbytes = Math.ceil(txDetails.weight / 4);
        const feeRate = Math.ceil(txDetails.fee / vbytes);
        if (feeRate > maxFeeRate) maxFeeRate = feeRate;
      }
    }
    return maxFeeRate;
  } catch (e) {
    console.error('Competitor detection error:', e);
    return 0;
  }
}

async function createSweepTx(keyPair, utxos, toAddress, feeSats, rbf = true) {
  const txb = new bitcoin.TransactionBuilder(NETWORK);
  let totalInput = 0;
  utxos.forEach(utxo => {
    txb.addInput(utxo.txid, utxo.vout);
    totalInput += utxo.value;
  });
  const amountToSend = totalInput - feeSats;
  if (amountToSend <= 0) throw new Error('Insufficient funds to cover fee');
  txb.addOutput(toAddress, amountToSend);
  if (rbf) {
    for (let i = 0; i < utxos.length; i++) {
      txb.setInputSequence(i, 0xfffffffd);
    }
  }
  utxos.forEach((_, i) => txb.sign(i, keyPair));
  return txb.build().toHex();
}

async function broadcastTx(txHex) {
  const url = `${ESPLORA_API}/tx`;
  const resp = await fetch(url, {
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

async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.error('Telegram send error:', e); }
}

function isAuthorized(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}

// ============================================================
// CORE SWEEP LOGIC
// ============================================================
async function sweepAll(env, chatId = null, specificMnemonic = null) {
  const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    MASTER_ADDRESS,
    MIN_BALANCE_TO_SWEEP = 10000,
    MAX_FEE_RATE = 50,
    FEE_BUMP = 3
  } = env;

  const targetChatId = chatId || TELEGRAM_CHAT_ID;
  if (!targetChatId || !MASTER_ADDRESS) {
    console.error('Missing Telegram chat ID or MASTER_ADDRESS');
    return;
  }

  const paused = await env.WALLETS.get('PAUSED') === 'true';
  if (paused) {
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, targetChatId, '⏸️ Sweeper is paused. Resume with /resume.');
    return;
  }

  try {
    let sources = [];
    if (specificMnemonic) {
      sources = getAllSourceAddresses(specificMnemonic);
    } else {
      const key = `wallets_${targetChatId}`;
      const stored = await env.WALLETS.get(key, 'json');
      if (stored && Array.isArray(stored)) {
        for (const wallet of stored) {
          const src = getAllSourceAddresses(wallet.mnemonic || wallet.wif);
          for (const item of src) {
            item.label = wallet.label || 'Unnamed';
            sources.push(item);
          }
        }
      }
    }

    if (sources.length === 0) {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, targetChatId, '❌ No source wallets imported. Use /import to add one.');
      return;
    }

    let anySwept = false;
    let totalSwept = 0;
    let report = [];

    for (const src of sources) {
      const utxos = await getUtxos(src.address);
      if (!utxos || utxos.length === 0) continue;

      const totalBalance = utxos.reduce((sum, u) => sum + u.value, 0);
      if (totalBalance < parseInt(MIN_BALANCE_TO_SWEEP)) continue;

      const competitorFee = await getHighestCompetitorFee(src.address);
      let ourFeeRate;
      if (competitorFee > 0) {
        ourFeeRate = competitorFee + parseInt(FEE_BUMP);
      } else {
        const recommended = await getRecommendedFee();
        ourFeeRate = Math.max(recommended, DEFAULT_SAT_PER_BYTE);
      }

      if (ourFeeRate > parseInt(MAX_FEE_RATE)) {
        report.push(`⚠️ ${src.label} (${src.address}): fee ${ourFeeRate} > cap ${MAX_FEE_RATE}, skipped.`);
        continue;
      }

      const inputCount = utxos.length;
      const estimatedVBytes = inputCount * 180 + 34 + 10;
      const feeSats = estimatedVBytes * ourFeeRate;
      const amountToSend = totalBalance - feeSats;

      if (amountToSend <= 0) {
        report.push(`⚠️ ${src.label} (${src.address}): balance ${totalBalance} sats too low for fee.`);
        continue;
      }

      const txHex = await createSweepTx(src.keyPair, utxos, MASTER_ADDRESS, feeSats, true);
      const txid = await broadcastTx(txHex);

      report.push(`✅ ${src.label} (${src.address}): sent ${(amountToSend/1e8).toFixed(8)} BTC, fee ${(feeSats/1e8).toFixed(8)} BTC, tx ${txid}`);
      totalSwept += amountToSend;
      anySwept = true;
    }

    if (anySwept) {
      const msg = `🚀 <b>Sweep completed!</b>\n\n` + report.join('\n') + `\n\nTotal swept: ${(totalSwept/1e8).toFixed(8)} BTC`;
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, targetChatId, msg);
    } else {
      if (report.length > 0) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, targetChatId, 'ℹ️ No sweepable balances:\n' + report.join('\n'));
      }
    }
  } catch (error) {
    console.error('Sweep error:', error);
    const errMsg = `❌ <b>Error during sweep:</b>\n${error.message}`;
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, targetChatId, errMsg);
  }
}

// ============================================================
// TELEGRAM BOT HANDLER
// ============================================================
async function handleTelegramUpdate(update, env) {
  const { TELEGRAM_BOT_TOKEN } = env;
  if (!update.message && !update.callback_query) return;

  let chatId, text, callbackData;

  if (update.message) {
    chatId = update.message.chat.id;
    text = update.message.text || '';
  } else if (update.callback_query) {
    chatId = update.callback_query.message.chat.id;
    callbackData = update.callback_query.data;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: update.callback_query.id })
    });
  }

  if (!chatId) return;

  if (text === '/start' || text === '/menu') {
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔑 Import Wallet', callback_data: 'import' }],
        [{ text: '📋 List Wallets', callback_data: 'list' }],
        [{ text: '➕ Add Recipient', callback_data: 'addrecipient' }],
        [{ text: '🧹 Sweep All', callback_data: 'sweep' }],
        [{ text: '📊 Check Balance', callback_data: 'balance' }],
        [{ text: '⏸️ Pause', callback_data: 'pause' }, { text: '▶️ Resume', callback_data: 'resume' }],
        [{ text: '🧪 Test API', callback_data: 'testapi' }]
      ]
    };
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
      '🤖 <b>Bitcoin Sweeper Bot</b>\n\nChoose an action:',
      keyboard);
    return;
  }

  if (callbackData) {
    switch (callbackData) {
      case 'import':
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
          '🔑 Send me your <b>mnemonic</b> (12/24 words) or <b>WIF private key</b>.\n\nExample:\n<code>abandon abandon ...</code>\nor\n<code>L5...</code>');
        break;
      case 'list': {
        const key = `wallets_${chatId}`;
        const storedWallets = await env.WALLETS.get(key, 'json') || [];
        if (storedWallets.length === 0) {
          await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '📭 No wallets imported.');
        } else {
          let msg = '📋 <b>Your Wallets:</b>\n\n';
          for (const w of storedWallets) {
            const label = w.label || 'Unnamed';
            const first = getAllSourceAddresses(w.mnemonic || w.wif)[0];
            msg += `🔹 <b>${label}</b>\n   ${first.address}\n`;
          }
          await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, msg);
        }
        break;
      }
      case 'addrecipient':
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
          '➕ Send me a Bitcoin address to add as a recipient (destination).\n\nExample: <code>bc1q...</code>');
        break;
      case 'sweep':
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '🧹 Sweeping all wallets...');
        await sweepAll(env, chatId, null);
        break;
      case 'balance':
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
          '📊 Send me a Bitcoin address to check its balance.');
        break;
      case 'pause':
        await env.WALLETS.put('PAUSED', 'true');
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⏸️ Sweeper paused.');
        break;
      case 'resume':
        await env.WALLETS.put('PAUSED', 'false');
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '▶️ Sweeper resumed.');
        break;
      case 'testapi': {
        try {
          const fee = await getRecommendedFee();
          const testAddress = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
          const utxos = await getUtxos(testAddress);
          const balance = utxos.reduce((sum, u) => sum + u.value, 0);
          await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
            `🧪 <b>API Test Results</b>\n\n` +
            `✅ Esplora reachable\n` +
            `💰 Test address balance: ${(balance/1e8).toFixed(8)} BTC\n` +
            `💸 Current fee: ${fee} sat/vbyte`);
        } catch (e) {
          await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ API test failed:\n${e.message}`);
        }
        break;
      }
      default:
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 'Unknown action.');
    }
    const keyboard = {
      inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]]
    };
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 'Back to menu:', keyboard);
    return;
  }

  // ---------- TEXT HANDLING ----------
  const words = text.trim().split(/\s+/);
  if (words.length >= 12 && words.length <= 24) {
    try {
      if (!bip39.validateMnemonic(words.join(' '))) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '❌ Invalid mnemonic.');
        return;
      }
      const key = `wallets_${chatId}`;
      const wallets = await env.WALLETS.get(key, 'json') || [];
      const exists = wallets.some(w => w.mnemonic === words.join(' '));
      if (exists) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Already imported.');
        return;
      }
      wallets.push({ mnemonic: words.join(' '), label: `Wallet ${wallets.length+1}` });
      await env.WALLETS.put(key, JSON.stringify(wallets));
      const src = getAllSourceAddresses(words.join(' '))[0];
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
        `✅ Wallet imported!\n\n🔹 Address: ${src.address}\n🔹 Label: Wallet ${wallets.length}`);
    } catch (e) {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ Error: ${e.message}`);
    }
    return;
  }

  if (/^[LK5][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(text.trim())) {
    try {
      const wif = text.trim();
      const keyPair = bitcoin.ECPair.fromWIF(wif, NETWORK);
      const address = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK }).address;
      const key = `wallets_${chatId}`;
      const wallets = await env.WALLETS.get(key, 'json') || [];
      const exists = wallets.some(w => w.wif === wif);
      if (exists) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, '⚠️ Already imported.');
        return;
      }
      wallets.push({ wif, label: `Wallet ${wallets.length+1}` });
      await env.WALLETS.put(key, JSON.stringify(wallets));
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
        `✅ Wallet imported!\n\n🔹 Address: ${address}\n🔹 Label: Wallet ${wallets.length}`);
    } catch (e) {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ Invalid WIF.`);
    }
    return;
  }

  // Bitcoin address (recipient)
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(text.trim()) || /^bc1[a-zA-HJ-NP-Z0-9]{39,59}$/.test(text.trim())) {
    const address = text.trim();
    const key = `recipients_${chatId}`;
    let recipients = await env.WALLETS.get(key, 'json') || [];
    if (!recipients.includes(address)) {
      recipients.push(address);
      await env.WALLETS.put(key, JSON.stringify(recipients));
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ Recipient added: ${address}`);
    } else {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `⚠️ Already in list.`);
    }
    return;
  }

  // /balance command
  if (text.startsWith('/balance')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const addr = parts[1];
      try {
        const utxos = await getUtxos(addr);
        const balance = utxos.reduce((sum, u) => sum + u.value, 0);
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId,
          `📊 <b>Balance for ${addr}</b>\n\n` +
          `💰 ${(balance/1e8).toFixed(8)} BTC\n` +
          `📦 ${utxos.length} UTXOs`);
      } catch (e) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, `❌ Error: ${e.message}`);
      }
    } else {
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 'Please provide an address: /balance <address>');
    }
    return;
  }

  const keyboard = {
    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]]
  };
  await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, 'I didn\'t understand that. Use the menu:', keyboard);
}

// ============================================================
// WORKER EXPORT
// ============================================================
export default {
  async scheduled(event, env, ctx) {
    await sweepAll(env, env.TELEGRAM_CHAT_ID, null);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/telegram-webhook') {
      const secret = env.TELEGRAM_WEBHOOK_SECRET;
      const received = request.headers.get('X-Telegram-Webhook-Secret');
      if (secret && received && received !== secret) {
        return new Response('Unauthorized', { status: 401 });
      }
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response('OK');
    }

    if (!isAuthorized(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method === 'POST' && pathname === '/add-wallet') {
      const address = url.searchParams.get('address');
      if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) && !/^bc1[a-zA-HJ-NP-Z0-9]{39,59}$/.test(address)) {
        return new Response('Invalid Bitcoin address', { status: 400 });
      }
      const recipients = (await env.WALLETS.get('recipients', 'json')) || [];
      if (!recipients.includes(address)) {
        recipients.push(address);
        await env.WALLETS.put('recipients', JSON.stringify(recipients));
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, `➕ Wallet added: ${address}`);
        return new Response(`Added ${address}`);
      }
      return new Response('Address already exists', { status: 409 });
    }

    if (request.method === 'GET' && pathname === '/list-wallets') {
      const recipients = (await env.WALLETS.get('recipients', 'json')) || [];
      return new Response(JSON.stringify(recipients), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && pathname === '/sweep') {
      const chatId = url.searchParams.get('chatId') || env.TELEGRAM_CHAT_ID;
      await sweepAll(env, chatId, null);
      return new Response('Sweep triggered');
    }

    if (request.method === 'POST' && pathname === '/pause') {
      await env.WALLETS.put('PAUSED', 'true');
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, '⏸️ Sweeper paused');
      return new Response('Paused');
    }

    if (request.method === 'POST' && pathname === '/resume') {
      await env.WALLETS.put('PAUSED', 'false');
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, '▶️ Sweeper resumed');
      return new Response('Resumed');
    }

    if (request.method === 'GET' && pathname === '/status') {
      const paused = (await env.WALLETS.get('PAUSED')) === 'true';
      const currentFee = await getRecommendedFee();
      const defaultChatId = env.TELEGRAM_CHAT_ID;
      const key = `wallets_${defaultChatId}`;
      const wallets = await env.WALLETS.get(key, 'json') || [];
      let balances = {};
      for (const w of wallets) {
        const mnemonic = w.mnemonic || w.wif;
        const sources = getAllSourceAddresses(mnemonic);
        for (const src of sources) {
          const utxos = await getUtxos(src.address);
          const balance = utxos ? utxos.reduce((sum, u) => sum + u.value, 0) : 0;
          balances[src.address] = { balance, utxos: utxos ? utxos.length : 0 };
        }
      }
      return new Response(JSON.stringify({ paused, currentFee, balances }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
