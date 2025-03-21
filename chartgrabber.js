process.removeAllListeners('warning');
import dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SESSION_HASH = `CONNECTS${Math.ceil(Math.random() * 1e9)}`;

////////////// ONLY CHANGE THESE VARIABLES ///////////////
let alreadyBought = false;
const smoothingFactor = 0.05;       // More responsive
const BASE_POS_THRESHOLD = 0.007;  // 0.3% base up
const BASE_NEG_THRESHOLD = -0.007; // -0.3% base down
const MIN_THRESHOLD = 0.0065;       // 0.1% min
const MAX_THRESHOLD = 0.008;       // 0.5% max
const updateSmoothingFactor = 0.2;
let emaUpdateCount = 0;
const ROLLING_WINDOW_MINUTES = 15; // 15-minute rolling window
const MIN_DATA_TIME_MINUTES = 15;   // Initial wait of 15 minutes
const MIN_DATA_POINTS = 400;       // Wait for 100 points for trend
const START_TIME = Date.now();     // Track app start time

// Adjustable baseline variables
const BASELINE_SLIPPAGE_UPTREND = 10;    // 0.1% for buying SOL
const BASELINE_SLIPPAGE_DOWNTREND = 20;  // 0.2% for selling SOL
const BASELINE_FEE_LAMPORTS = 500000;    // 0.0005 SOL
const MAX_SLIPPAGE_BPS = 100;            // 1% cap
const MAX_FEE_LAMPORTS = 2000000;        // 0.002 SOL cap
//////////////////////////////////////////////////////////

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }

function logError(error) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${error.stack}\n`;
    fs.appendFileSync(path.join(logDir, 'errors.log'), logEntry);
    console.error(error);
}

const { decode } = bs58;
const WALLET_SECRET_KEY = process.env.PRVKEY;
const walletAddress = process.env.PUBKEY;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MIN_SOL_RESERVE = 0.005 * 1e9;
let AMOUNT_SOL = 0;
let AMOUNT_USDC = 0;
let lastBoughtPrice = null;
const colors = { reset: "\x1b[0m", fg: { gray: "\x1b[90m", green: "\x1b[32m", red: "\x1b[31m", blue: "\x1b[34m" } };
let firstRun = true;
let startUp = true;
let currentTrend = "none";
let lastTrend = "none";
let trendCount = 0;
let updateCount = 0;
const emaUpdateCounts = [];
let averageEMAUpdateCount = 0;
let lastPriceTime = Date.now();
const PRICE_TIMEOUT = 30 * 1000;

if (!WALLET_SECRET_KEY) { console.error('Missing private key from environment variables.'); }

let wallet;
try {
    const decodedSecretKey = decode(WALLET_SECRET_KEY);
    wallet = Keypair.fromSecretKey(decodedSecretKey);
} catch (error) {
    logError(error);
}

function lamportsToSol(lamports) {
    const SOL_PER_LAMPORTS = 1000000000;
    return lamports / SOL_PER_LAMPORTS;
}

function lamportsToUSDC(lamports) {
    const USDC_PER_LAMPORTS = 1000000;
    return lamports / USDC_PER_LAMPORTS;
}

async function usdcToUSDC(usdcConvert) {
    if (typeof usdcConvert !== 'bigint') { throw new TypeError("Input must be a BigInt."); }
    if (usdcConvert > Number.MAX_SAFE_INTEGER || usdcConvert < Number.MIN_SAFE_INTEGER) {
        console.warn("BigInt value exceeds Number.MAX_SAFE_INTEGER/MIN_SAFE_INTEGER. Precision may be lost.");
    }
    return Number(usdcConvert);
}

async function getConnection() {
    const endpointUrls = [
        {
            http: 'https://solana-rpc.publicnode.com',
            ws: 'wss://mainnet.helius-rpc.com/?api-key=',
            headers: { 'x-session-hash': SESSION_HASH },
        },
        {
            http: 'https://api.mainnet-beta.solana.com',
            ws: 'wss://cosmological-silent-meadow.solana-mainnet.quiknode.pro/',
            headers: { 'x-session-hash': SESSION_HASH },
        },
    ];
    for (const urlPair of endpointUrls) {
        try {
            const connection = new Connection(urlPair.http, {
                wsEndpoint: urlPair.ws,
                httpHeaders: urlPair.headers || {},
                commitment: 'confirmed',
            });
            await connection.getEpochInfo();
            return connection;
        } catch (error) {
            console.error(`Connection failed for ${urlPair.http} (ws: ${urlPair.ws}):`, error.message);
        }
    }
    throw new Error("All combined HTTP/WebSocket connections are currently unavailable.");
}

async function updateBalances() {
    try {
        const connection = await getConnection();
        const publicKey = new PublicKey(walletAddress);
        const solBalance = await connection.getBalance(publicKey).catch(error => {
            console.error('SOL balance check failed:', error.message);
            return 0;
        });
        let usdcBalance = 0;
        try {
            const associatedTokenAddress = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey);
            const account = await getAccount(connection, associatedTokenAddress);
            usdcBalance = account.amount;
        } catch (error) {
            console.error('USDC balance check failed:', error.message);
        }
        AMOUNT_SOL = solBalance;
        AMOUNT_USDC = await usdcToUSDC(usdcBalance);
        console.log('          wallet updated');
        console.log("----------------------------------");
    } catch (error) {
        console.log('Balance update failed:', error.message);
    }
}

async function getQuote(inputMint, outputMint, amount, slippageBps) {
    let response;
    try {
        response = await fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true&onlyDirectRoutes=true`,
            { signal: AbortSignal.timeout(10000) }
        );
        if (!response.ok) throw new Error(`Failed to fetch quote: ${response.statusText}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching quote:', error);
        throw error;
    } finally {
        if (response && response.body && !response.body.locked) {
            response.body.cancel().catch(error => {
                console.error('Error canceling response body:', error);
            });
        }
    }
}

let isSwapInProgress = false;
const COOLDOWN_PERIOD = 60 * 1000;

async function getDynamicSlippageBps(isUptrend, attempt) {
    const baselineSlippage = isUptrend ? BASELINE_SLIPPAGE_UPTREND : BASELINE_SLIPPAGE_DOWNTREND;
    const recentPrices = priceHistory.slice(-10).map(entry => entry.price);
    
    if (recentPrices.length < 2 || attempt < 2) return baselineSlippage; // Use baseline for first two attempts
    
    const mean = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length;
    const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length;
    const volatility = Math.sqrt(variance);
    
    return Math.max(baselineSlippage, Math.min(MAX_SLIPPAGE_BPS, volatility * 1000));
}

async function getDynamicFee(connection, attempt) {
    const feeSteps = [BASELINE_FEE_LAMPORTS, 1000000, 1500000, MAX_FEE_LAMPORTS];
    const recentFees = await connection.getRecentPrioritizationFees();
    const avgFee = recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length || BASELINE_FEE_LAMPORTS;

    const feeIndex = Math.min(Math.floor(attempt / 2), feeSteps.length - 1); // Increase every 2 attempts
    const fee = Math.max(avgFee, feeSteps[feeIndex]);
    
    return {
        maxLamports: fee,
        priorityLevel: fee > 1500000 ? "high" : fee > 1000000 ? "medium" : "low"
    };
}

async function swap(inputMint, outputMint, amount, isUptrend) {
    if (isSwapInProgress) {
        console.error("Swap already in progress. Ignoring this call.");
        return;
    }
    isSwapInProgress = true;

    try {
        if (!inputMint || !outputMint || !amount) {
            throw new Error("Invalid input parameters for swap.");
        }

        const connection = await getConnection();
        if (!connection || !wallet?.publicKey) throw new Error("Connection or wallet not initialized.");

        let signature;
        let attempt = 0;

        while (true) { // No max retry limit
            try {
                const slippageBps = await getDynamicSlippageBps(isUptrend, attempt);
                const fee = await getDynamicFee(connection, attempt);
                console.log(`Attempt ${attempt + 1}: Slippage=${slippageBps / 100}%, Fee=${fee.maxLamports / 1e9} SOL`);

                const quoteResponse = await getQuote(inputMint, outputMint, amount, slippageBps);
                if (!quoteResponse) throw new Error("Failed to fetch quote.");

                const swapResponse = await fetch('https://api.jup.ag/swap/v1/swap', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        quoteResponse,
                        userPublicKey: wallet.publicKey.toString(),
                        dynamicComputeUnitLimit: true,
                        slippageBps,
                        prioritizationFeeLamports: fee
                    }),
                    signal: AbortSignal.timeout(10000)
                });

                if (!swapResponse.ok) {
                    const errorBody = await swapResponse.text();
                    throw new Error(`API Error: ${errorBody}`);
                }

                const swapData = await swapResponse.json();
                if (!swapData?.swapTransaction) throw new Error("Missing swapTransaction in response.");

                const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
                transaction.sign([wallet]);

                signature = await connection.sendRawTransaction(transaction.serialize(), {
                    maxRetries: 2,
                    skipPreflight: false
                });

                console.log(`Transaction succeeded: https://solscan.io/tx/${signature}`);
                break; // Success, exit loop

            } catch (error) {
                attempt++;
                console.error(`Swap attempt ${attempt} failed: ${error.message}`);
                if (attempt === 1) {
                    console.log("First attempt failed, increasing fees...");
                } else if (attempt === 2) {
                    console.log("Second attempt failed, adjusting slippage...");
                } else {
                    console.log(`Attempt ${attempt + 1}: Escalating fees/slippage...`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.min(attempt, 5))); // Cap backoff at 5s
            }
        }

        await retryUntilSuccess(async () => {
            await updateBalances();
            console.log("Balances updated successfully.");
        });

        return signature;

    } catch (error) {
        console.error("Unexpected error in swap logic:", error);
        throw error; // Shouldn’t happen with infinite retries
    } finally {
        setTimeout(() => {
            isSwapInProgress = false;
            console.log("Swap cooldown period over. Resetting to baseline values.");
        }, COOLDOWN_PERIOD);
    }
}

async function retryUntilSuccess(fn, retryDelay = 3000) {
    while (true) {
        try {
            await fn();
            break;
        } catch (error) {
            console.error("Retryable error:", error);
            if (error.message && error.message.includes("Simulation failed")) {
                console.error("Stopping retries due to 'Simulation failed' error.");
                break;
            }
            console.log(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

// EMA and price history
let priceHistory = [];
let ema = null;
let previousEma = null;

function calculateRollingEMA(previousEMA, currentPrice, smoothingFactor) {
    return (currentPrice * smoothingFactor) + (previousEMA * (1 - smoothingFactor));
}

async function checkTrend(currentPrice) {
    const currentTime = Date.now();
    priceHistory.push({ price: currentPrice, timestamp: currentTime });

    // 15-minute rolling window
    const rollingWindowStart = currentTime - (ROLLING_WINDOW_MINUTES * 60 * 1000);
    priceHistory = priceHistory.filter(entry => entry.timestamp >= rollingWindowStart);

    if (priceHistory.length === 0) return;

    const totalRuntimeMinutes = (currentTime - START_TIME) / (60 * 1000);
    const hasEnoughData = totalRuntimeMinutes >= MIN_DATA_TIME_MINUTES && priceHistory.length >= MIN_DATA_POINTS;

    if (!hasEnoughData) {
        console.log(`Waiting for more data: ${priceHistory.length} points, ${totalRuntimeMinutes.toFixed(1)} minutes since start`);
        currentTrend = "none";
        trendCount = 0;
        return;
    }

    if (ema === null) {
        ema = currentPrice;
        previousEma = ema;
        console.log(`Initial EMA: ${ema.toFixed(5)}`);
        return;
    }

    ema = calculateRollingEMA(previousEma, currentPrice, smoothingFactor);
    console.log(`EMA: ${ema.toFixed(5)}`);
    console.log('avgPriceUpdateCount:', averageEMAUpdateCount);

    const netChange = (previousEma !== 0 && !isNaN(ema) && !isNaN(previousEma))
        ? (((ema - previousEma) / previousEma) * 100)
        : 0;
    console.log(`Net Change: ${netChange.toFixed(5)}%`);

    const volatilityFactor = emaUpdateCount / (averageEMAUpdateCount || 1);
    let posThreshold = Math.min(Math.max(BASE_POS_THRESHOLD / (volatilityFactor + 0.1), MIN_THRESHOLD), MAX_THRESHOLD);
    let negThreshold = Math.max(Math.min(BASE_NEG_THRESHOLD / (volatilityFactor + 0.1), -MIN_THRESHOLD), -MAX_THRESHOLD);

    console.log(`Thresholds: pos=${posThreshold.toFixed(5)}, neg=${negThreshold.toFixed(5)}`);
    console.log(`Volatility Factor: ${volatilityFactor.toFixed(2)}`);

    if (netChange > posThreshold && priceHistory.length > 1) {
        if (trendCount >= 2) {
            currentTrend = "pos";
        }
        trendCount++;
        console.log(`${colors.fg.green}Upward trend detected!${colors.reset}`);
    } else if (netChange < negThreshold && priceHistory.length > 1) {
        if (trendCount >= 2) {
            currentTrend = "neg";
        }
        trendCount++;
        console.log(`${colors.fg.red}Downward trend detected!${colors.reset}`);
    } else {
        trendCount = 0;
        console.log(`${colors.fg.gray}No trend detected.${colors.reset}`);
    }
    console.log("----------------------------------");
    previousEma = ema;
}

async function getPercentage(number, percentage) {
    if (typeof number !== 'number' || typeof percentage !== 'number') { return "Invalid input. Please provide numbers."; }
    if (percentage < 0 || percentage > 100) { return "Invalid percentage. Please provide a value between 0 and 100."; }
    return (number * percentage) / 100;
}

let lastUpdateMinute = -1;

async function monitorPrice(price) {
    lastPriceTime = Date.now();
    updateCount++;
    try {
        if (startUp) {
            await updateBalances();
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`);
            startUp = false;
        } else {
            console.log('1 SOL ===', price, 'USDC');
            console.log('USDCL:', AMOUNT_USDC, 'SOLL:', AMOUNT_SOL);
            console.log('lastBoughtPrice:', lastBoughtPrice);
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`);
            console.log('swapInProgress:', isSwapInProgress, 'currentTrend:', currentTrend);
            await checkTrend(Number(price));

            const currentMinute = new Date().getMinutes();
            if (currentMinute % 5 === 0 && currentMinute !== lastUpdateMinute) {
                await retryUntilSuccess(() => updateBalances());
                lastUpdateMinute = currentMinute;
            }

            if (currentTrend === "pos" && !isSwapInProgress && !alreadyBought) {
                if (lastTrend === "pos") return;
                lastBoughtPrice = price;
                const compoundDaUSDC = Math.round(AMOUNT_USDC * 0.999);
                const didSwap = await swap(USDC_MINT, SOL_MINT, compoundDaUSDC, true); // Uptrend
                console.log("BUY");
                console.log("----------------------------------");
                if (didSwap) lastTrend = "pos";
                firstRun = false;
            } else if (currentTrend === "neg" && !firstRun && !isSwapInProgress) {
                if (lastTrend === "neg") return;
                console.log("SELL");
                console.log("----------------------------------");
                const tradableSOL = AMOUNT_SOL - MIN_SOL_RESERVE;
                const swapSOLtoUSDC = Math.round(tradableSOL);
                if (swapSOLtoUSDC > 0) {
                    await swap(SOL_MINT, USDC_MINT, swapSOLtoUSDC, false); // Downtrend
                    console.log("SELL - Swapped all tradable SOL, leaving 0.005 SOL");
                }
                alreadyBought = false;
                lastTrend = "neg";
            }
        }
    } catch (error) {
        logError(error);
    }
}

const streamToUSDC = lamports => lamports / 1e8;
const priceHandlers = [
    { prefix: 'pythnet price:', label: 'Solana PythNet' },
    { prefix: 'doves price:', label: 'Solana Doves' }
];

function processPrice(logEntry, { prefix, label }) {
    if (!logEntry.includes(prefix)) return null;
    const priceString = logEntry.split(prefix)[1]?.split(',')[0]?.trim();
    if (!priceString) return null;
    const price = Math.round(streamToUSDC(priceString) * 100) / 100;
    if (price > 100 && price < 300) { return price; }
    return null;
}

let connection;
let subscriptionId;

async function startMonitoring() {
    if (connection && subscriptionId) {
        connection.removeOnLogsListener(subscriptionId);
    }
    connection = await getConnection();
    const throttle = (fn, wait) => {
        let lastCall = 0;
        let timeout;
        return (arg) => {
            const now = Date.now();
            if (now - lastCall >= wait) {
                lastCall = now;
                fn(arg);
            } else if (!timeout) {
                timeout = setTimeout(() => {
                    lastCall = now;
                    fn(arg);
                    timeout = null;
                }, wait - (now - lastCall));
            }
        };
    };

    let lastProcessedPrice = null;
    const throttledMonitorPrice = throttle(monitorPrice, 333);

    subscriptionId = connection.onLogs(
        new PublicKey('11111111111111111111111111111111'),
        ({ logs }) => {
            const prices = logs.flatMap(log => {
                for (const handler of priceHandlers) {
                    const price = processPrice(log, handler);
                    if (typeof price === 'number') return [price];
                }
                return [];
            });

            let newPrice = null;
            if (prices.length >= 2) {
                const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
                newPrice = Math.round(average * 100) / 100;
            } else if (prices.length === 1) {
                newPrice = Math.round(prices[0] * 100) / 100;
            }

            if (newPrice !== null && newPrice !== lastProcessedPrice) {
                throttledMonitorPrice(newPrice);
                lastProcessedPrice = newPrice;
            }
        },
        'confirmed'
    );
}

function calculateAverageEMAUpdateCount(emaUpdateCounts) {
    if (emaUpdateCounts.length === 0) return 0;
    const totalEMAUpdates = emaUpdateCounts.reduce((sum, count) => sum + count, 0);
    return totalEMAUpdates / emaUpdateCounts.length;
}

async function monitorLogs() {
    console.log('\x1b[32m%s\x1b[0m', `
    +-+-+-+-+-+-+-+-+-+-+-+-+
    |C|h|a|r|t|G|r|a|b|b|e|r|
    +-+-+-+-+-+-+-+-+-+-+-+-+`);
    await startMonitoring();
    setInterval(() => {
        if (Date.now() - lastPriceTime > PRICE_TIMEOUT) {
            console.log('No price updates for 1 minute, resubscribing...');
            if (connection && subscriptionId) { connection.removeOnLogsListener(subscriptionId); }
            startMonitoring();
        }
    }, PRICE_TIMEOUT);
    setInterval(() => {
        emaUpdateCount = (updateCount * updateSmoothingFactor) + (emaUpdateCount * (1 - updateSmoothingFactor));
        emaUpdateCounts.push(emaUpdateCount);
        if (emaUpdateCounts.length > ROLLING_WINDOW_MINUTES) {
            emaUpdateCounts.shift();
        }
        averageEMAUpdateCount = calculateAverageEMAUpdateCount(emaUpdateCounts);
        console.log(`EMA Update Count: ${emaUpdateCount.toFixed(2)}`);
        updateCount = 0;
    }, 60000);
}

monitorLogs();
