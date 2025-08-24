import mongoose from "mongoose";
import PaperState from "../models/PaperState.js";
import PaperTrade from "../models/PaperTrade.js";
import Equity from "../models/Equity.js";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// Keep coins small and focussed for accuracy
const COINS = ["bitcoin","ethereum"]; // add later once you’re happy

// Params from env (with defaults)
const START_BAL = Number(process.env.PAPER_START_BAL || 10000);
const THRESH_ENTER = Number(process.env.PAPER_TRADE_THRESHOLD || 0.62);
const THRESH_EXIT  = Number(process.env.PAPER_EXIT_THRESHOLD || 0.50);
const MAX_POS_PCT  = Number(process.env.PAPER_MAX_POS_PCT || 0.5);
const FEE_BPS      = Number(process.env.PAPER_FEE_BPS || 10);   // 10 bps = 0.1%
const MAX_HOLD_MS  = 24 * 60 * 60 * 1000; // exit after 24h

const V4_THRESH = {
  bitcoin: Number(process.env.V4_THRESH_BTC || '0.62'),
  ethereum: Number(process.env.V4_THRESH_ETH || '0.60'),
};
const BASE_THRESH = Number(process.env.PAPER_THRESH || '0.60');


function feeUSD(notional) { return (notional * FEE_BPS) / 10000; }



async function getLatestPrice(coin) {
  return Price.findOne({ coin }).sort({ ts: -1 }).lean();
}

const ACTIVE_MODEL = process.env.PAPER_MODEL_VER || "v3-macd-bb";

async function getLatestPred(coin) {
  return Prediction.findOne({ coin, horizon: "24h", model_ver: ACTIVE_MODEL })
    .sort({ ts: -1 }).lean();
}


async function ensureState() {
  let s = await PaperState.findById("default");
  if (!s) {
    s = await PaperState.create({
      _id: "default",
      cash_usd: START_BAL,
      equity_usd: START_BAL,
      holdings: [],
      params: {
        start_bal: START_BAL, trade_threshold: THRESH_ENTER, exit_threshold: THRESH_EXIT,
        max_pos_pct: MAX_POS_PCT, fee_bps: FEE_BPS
      }
    });
  }
  return s;
}

function findHolding(state, coin) {
  return state.holdings.find(h => h.coin === coin);
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });

    const state = await ensureState();

    // Preload latest prices & preds
    const latest = {};
    for (const c of COINS) {
      latest[c] = {
        price: await getLatestPrice(c),
        pred:  await getLatestPred(c)
      };
    }

    // Mark-to-market and decide actions
    let equity = state.cash_usd;
    const by_coin = [];

    for (const coin of COINS) {
const px = latest[coin].price?.price;
const predDoc = latest[coin].pred;
const prob = Number(predDoc?.p_up ?? predDoc?.prob_up ?? predDoc?.p ?? NaN);
const now = new Date();

      const hold = findHolding(state, coin);
      const markValue = hold ? hold.qty * (px || 0) : 0;
      equity += markValue;
      by_coin.push({ coin, qty: hold?.qty || 0, mark_price: px || 0, value_usd: markValue });

      // If we don't have price or prediction, skip trading logic
if (!px || !Number.isFinite(prob)) continue;

      // Exit rules (if holding)
      if (hold && hold.qty > 0) {
        const ageMs = now - new Date(hold.opened_at);
        const timeout = ageMs >= MAX_HOLD_MS;
const exitSignal = prob < THRESH_EXIT || timeout;

        if (exitSignal) {
          const notional = hold.qty * px;
          const fee = feeUSD(notional);
          const pnl = (px - hold.entry_price) * hold.qty - fee;

          // realize: sell entire qty
          state.cash_usd += (notional - fee);
          // remove holding
          state.holdings = state.holdings.filter(h => h.coin !== coin);

          await PaperTrade.create({
            ts: now, coin, side: "SELL", qty: hold.qty, price: px,
            fee_usd: fee, pnl_usd: pnl, reason: timeout ? "timeout_24h" : "exit_threshold"
          });
        }
      }

      // Entry rule (if flat)
const isV4 = (predDoc?.model_ver || ACTIVE_MODEL) === "v4-ai-logreg";
const ENTER = isV4 ? (V4_THRESH[coin] ?? THRESH_ENTER) : THRESH_ENTER;

if (!stillHolding && prob >= ENTER) {
        // target size = MAX_POS_PCT * equity
        const targetNotional = equity * MAX_POS_PCT;
        const qty = targetNotional / px;
        if (qty > 0) {
          const fee = feeUSD(targetNotional);
          const cost = targetNotional + fee;
          if (state.cash_usd >= cost) {
            state.cash_usd -= cost;
            state.holdings.push({ coin, qty, entry_price: px, opened_at: now });
            await PaperTrade.create({
              ts: now, coin, side: "BUY", qty, price: px,
              fee_usd: fee, pnl_usd: null, reason: "enter_threshold"
            });
          }
        }
      }
    }

    // Recompute equity post-trades (mark-to-market again)
    let finalEquity = state.cash_usd;
    for (const h of state.holdings) {
      const px = latest[h.coin].price?.price || 0;
      finalEquity += h.qty * px;
    }

    state.equity_usd = finalEquity;
    state.updated_at = new Date();
    await state.save();

    await Equity.create({
      ts: new Date(),
      equity_usd: finalEquity,
      cash_usd: state.cash_usd,
      by_coin
    });

    console.log(`[${new Date().toISOString()}] Paper: equity=${finalEquity.toFixed(2)} cash=${state.cash_usd.toFixed(2)} holdings=${state.holdings.length}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Paper job error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
