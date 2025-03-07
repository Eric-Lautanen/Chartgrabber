// Remove all warning listeners from the process
process.removeAllListeners('warning');

// Import required modules
import dotenv from 'dotenv'; // For environment variable management
dotenv.config(); // Load environment variables from .env file
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js'; // Solana blockchain utilities
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'; // SPL token utilities
import bs58 from 'bs58'; // Base58 encoding/decoding
import fs from 'fs'; // File system operations
import path from 'path'; // Path utilities
import { fileURLToPath } from 'url'; // URL to file path conversion

// Generate a unique session hash for connection tracking
const SESSION_HASH = `CONNECTS${Math.ceil(Math.random() * 1e9)}`;

// YOU'LL PROBABLY HAVE TO TWEAK THE JUIPITER SETTINGS DOWN BELOW TO GAURANTEE BUYS/SELLS KEEP LAMPORTS AND SLIPPAGE AS LOW AS YOU CAN FOR HIGHER PROFITS.
// THIS BOT CAN AUTO COMPOUND OFF STARTING VALUE OF $20 OR SO PRETTY EASILY.... HAVE FUN!

////////////// ONLY CHANGE THESE VARIABLES ///////////////
// Trading state and parameters
let alreadyBought = false; // Tracks if a buy has occurred or if bot crashes after a buy or something
let initialSlippageBps = 40; // Initial slippage tolerance in basis points
const smoothingFactor = 0.05; // EMA smoothing factor
const BASE_POS_THRESHOLD = 0.007; // Base positive trend threshold
const BASE_NEG_THRESHOLD = -0.007; // Base negative trend threshold
const MIN_THRESHOLD = 0.0065; // Minimum threshold limit
const MAX_THRESHOLD = 0.008; // Maximum threshold limit
const updateSmoothingFactor = 0.2; // Update frequency smoothing
let emaUpdateCount = 0; // EMA update counter
const ROLLING_WINDOW_MINUTES = 15; // Price history window size
const MIN_DATA_TIME_MINUTES = 15; // Minimum runtime before trading
const MIN_DATA_POINTS = 400; // Minimum price points before trading
const START_TIME = Date.now(); // Bot start timestamp
//////////////////////////////////////////////////////////

// Setup file paths for logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, 'logs');
// Create logs directory if it doesn't exist
if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }

// Error logging function
function logError(error) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${error.stack}\n`;
    fs.appendFileSync(path.join(logDir, 'errors.log'), logEntry);
    console.error(error);
}

// Wallet setup
const { decode } = bs58;
const WALLET_SECRET_KEY = process.env.PRVKEY; // Private key from env
const walletAddress = process.env.PUBKEY; // Public key from env
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // SOL token address
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC token address
const MIN_SOL_RESERVE = 0.005 * 1e9; // Minimum SOL to keep in wallet
let AMOUNT_SOL = 0; // Current SOL balance
let AMOUNT_USDC = 0; // Current USDC balance
let lastBoughtPrice = null; // Last purchase price
// Console color codes
const colors = { reset: "\x1b[0m", fg: { gray: "\x1b[90m", green: "\x1b[32m", red: "\x1b[31m", blue: "\x1b[34m" } };
// Trading state variables
let firstRun = true; // First run flag
let startUp = true; // Startup flag
let currentTrend = "none"; // Current price trend
let lastTrend = "none"; // Previous trend
let trendCount = 0; // Consecutive trend counter
let updateCount = 0; // Price update counter
const emaUpdateCounts = []; // EMA update count history
let averageEMAUpdateCount = 0; // Average EMA updates
let lastPriceTime = Date.now(); // Last price update timestamp
const PRICE_TIMEOUT = 30 * 1000; // Price update timeout

// Validate wallet secret key
if (!WALLET_SECRET_KEY) { console.error('Missing private key from environment variables.'); }

let wallet; // Wallet keypair
try {
    const decodedSecretKey = decode(WALLET_SECRET_KEY);
    wallet = Keypair.fromSecretKey(decodedSecretKey); // Initialize wallet
} catch (error) {
    logError(error);
}

// Conversion utilities
function lamportsToSol(lamports) {
    const SOL_PER_LAMPORTS = 1000000000;
    return lamports / SOL_PER_LAMPORTS; // Convert lamports to SOL
}

function lamportsToUSDC(lamports) {
    const USDC_PER_LAMPORTS = 1000000;
    return lamports / USDC_PER_LAMPORTS; // Convert lamports to USDC
}

async function usdcToUSDC(usdcConvert) {
    if (typeof usdcConvert !== 'bigint') { throw new TypeError("Input must be a BigInt."); }
    // Warn if value exceeds safe integer range
    if (usdcConvert > Number.MAX_SAFE_INTEGER || usdcConvert < Number.MIN_SAFE_INTEGER) {
        console.warn("BigInt value exceeds Number.MAX_SAFE_INTEGER/MIN_SAFE_INTEGER. Precision may be lost.");
    }
    return Number(usdcConvert); // Convert BigInt to Number
}

// Establish Solana connection
async function getConnection() {
    const endpointUrls = [
        // Primary endpoint
        {
            http: 'https://solana-rpc.publicnode.com',
            ws: 'wss://mainnet.helius-rpc.com/?api-key=',
            headers: { 'x-session-hash': SESSION_HASH },
        },
        // Fallback endpoint
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
                commitment: 'confirmed', // Confirmation level
            });
            await connection.getEpochInfo(); // Test connection
            return connection;
        } catch (error) {
            console.error(`Connection failed for ${urlPair.http} (ws: ${urlPair.ws}):`, error.message);
        }
    }
    throw new Error("All combined HTTP/WebSocket connections are currently unavailable.");
}

// Update wallet balances
async function updateBalances() {
    try {
        const connection = await getConnection();
        const publicKey = new PublicKey(walletAddress);
        // Get SOL balance
        const solBalance = await connection.getBalance(publicKey).catch(error => {
            console.error('SOL balance check failed:', error.message);
            return 0;
        });
        let usdcBalance = 0;
        try {
            // Get USDC token account balance
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

// Fetch swap quote from Jupiter API
async function getQuote(inputMint, outputMint, amount, slippageBps) {
    let response;
    try {
        response = await fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true&onlyDirectRoutes=true`,
            { signal: AbortSignal.timeout(10000) } // 10s timeout
        );
        if (!response.ok) throw new Error(`Failed to fetch quote: ${response.statusText}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching quote:', error);
        throw error;
    } finally {
        // Cleanup response body
        if (response && response.body && !response.body.locked) {
            response.body.cancel().catch(error => {
                console.error('Error canceling response body:', error);
            });
        }
    }
}

// Swap execution control
let isSwapInProgress = false;
const COOLDOWN_PERIOD = 60 * 1000; // 1 minute cooldown

// Execute token swap
async function swap(inputMint, outputMint, amount) {
    if (isSwapInProgress) {
        console.error("Swap function is already in progress or recently completed. Ignoring this call.");
        return;
    }
    isSwapInProgress = true;
    try {
        // Validate inputs
        if (!inputMint || !outputMint || !amount) {
            throw new Error("Invalid input parameters for swap: inputMint, outputMint, and amount are required.");
        }
        const connection = await getConnection();
        if (!connection) throw new Error("Failed to establish connection.");
        if (!wallet?.publicKey) throw new Error("Wallet not initialized.");
        let signature;
        // Retry swap until successful
        await retryUntilSuccess(async () => {
            const quoteResponse = await getQuote(inputMint, outputMint, amount, initialSlippageBps);
            if (!quoteResponse) throw new Error("Failed to fetch quote.");
            // Request swap transaction
            const swapResponse = await fetch('https://api.jup.ag/swap/v1/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    dynamicComputeUnitLimit: true,
                    slippageBps: initialSlippageBps,
                    prioritizationFeeLamports: { 
                        priorityLevelWithMaxLamports: { 
                            maxLamports: 500000, 
                            priorityLevel: "medium" 
                        } 
                    }
                }),
                signal: AbortSignal.timeout(10000)
            });

            if (!swapResponse.ok) {
                const errorBody = await swapResponse.text();
                throw new Error(`API Error`);
            }

            const swapData = await swapResponse.json();
            if (!swapData?.swapTransaction) throw new Error("Invalid swap response from API: missing swapTransaction.");
            // Execute transaction
            const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
            transaction.sign([wallet]);
            signature = await connection.sendRawTransaction(transaction.serialize(), {
                maxRetries: 2,
                skipPreflight: false
            });
        });

        console.log(`Transaction submitted: https://solscan.io/tx/${signature}`);
        // Update balances after swap
        await retryUntilSuccess(async () => {
            await updateBalances();
            console.log("Balances updated successfully.");
        });

        return signature;
    } catch (error) {
        console.error("Swap failed:", error);
        throw error;
    } finally {
        // Reset swap lock after cooldown
        setTimeout(() => {
            isSwapInProgress = false;
            console.log("Swap cooldown period over. Ready for the next call.");
        }, COOLDOWN_PERIOD);
    }
}

// Retry function for operations that might fail
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

// EMA and price tracking
let priceHistory = []; // Price history array
let ema = null; // Current EMA value
let previousEma = null; // Previous EMA value

// Calculate Exponential Moving Average
function calculateRollingEMA(previousEMA, currentPrice, smoothingFactor) {
    return (currentPrice * smoothingFactor) + (previousEMA * (1 - smoothingFactor));
}

// Analyze price trend
async function checkTrend(currentPrice) {
    const currentTime = Date.now();
    priceHistory.push({ price: currentPrice, timestamp: currentTime });
    // Maintain rolling window
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

    // Dynamic threshold adjustment based on volatility
    const volatilityFactor = emaUpdateCount / (averageEMAUpdateCount || 1);
    let posThreshold = Math.min(Math.max(BASE_POS_THRESHOLD / (volatilityFactor + 0.1), MIN_THRESHOLD), MAX_THRESHOLD);
    let negThreshold = Math.max(Math.min(BASE_NEG_THRESHOLD / (volatilityFactor + 0.1), -MIN_THRESHOLD), -MAX_THRESHOLD);

    console.log(`Thresholds: pos=${posThreshold.toFixed(5)}, neg=${negThreshold.toFixed(5)}`);
    console.log(`Volatility Factor: ${volatilityFactor.toFixed(2)}`);

    // Trend detection
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

// Percentage calculation utility
async function getPercentage(number, percentage) {
    if (typeof number !== 'number' || typeof percentage !== 'number') { return "Invalid input. Please provide numbers."; }
    if (percentage < 0 || percentage > 100) { return "Invalid percentage. Please provide a value between 0 and 100."; }
    return (number * percentage) / 100;
}

let lastUpdateMinute = -1; // Last balance update minute

// Main price monitoring function
async function monitorPrice(price) {
    lastPriceTime = Date.now();
    updateCount++;
    try {
        if (startUp) {
            await updateBalances();
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`);
            startUp = false;
        } else {
            // Display current market info
            console.log('1 SOL ===', price, 'USDC');
            console.log('USDCL:', AMOUNT_USDC, 'SOLL:', AMOUNT_SOL);
            console.log('lastBoughtPrice:', lastBoughtPrice);
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`);
            console.log('swapInProgress:', isSwapInProgress, 'currentTrend:', currentTrend);
            await checkTrend(Number(price));

            // Periodic balance update (every 5 minutes)
            const currentMinute = new Date().getMinutes();
            if (currentMinute % 5 === 0 && currentMinute !== lastUpdateMinute) {
                await retryUntilSuccess(() => updateBalances());
                lastUpdateMinute = currentMinute;
            }

            // Buy logic
            if (currentTrend === "pos" && !isSwapInProgress && !alreadyBought) {
                if (lastTrend === "pos") return;
                lastBoughtPrice = price;
                const compoundDaUSDC = Math.round(AMOUNT_USDC * 0.999); // Use 99.9% of USDC
                const didSwap = await swap(USDC_MINT, SOL_MINT, compoundDaUSDC);
                console.log("BUY");
                console.log("----------------------------------");
                if (didSwap) lastTrend = "pos";
                lastTrend = "pos";
                firstRun = false;
            } 
            // Sell logic
            else if (currentTrend === "neg" && !firstRun && !isSwapInProgress) {
                if (lastTrend === "neg") return;
                console.log("SELL");
                console.log("----------------------------------");
                const tradableSOL = AMOUNT_SOL - MIN_SOL_RESERVE;
                const swapSOLtoUSDC = Math.round(tradableSOL);
                if (swapSOLtoUSDC > 0) {
                    await swap(SOL_MINT, USDC_MINT, swapSOLtoUSDC);
                    console.log("SELL - Swapped all tradable SOL, leaving 0.005 SOL");
                }
                alreadyBought = false;
                console.log("Sell order triggered");
                lastTrend = "neg";
            }
        }
    } catch (error) {
        logError(error);
    }
}

// Price conversion utility
const streamToUSDC = lamports => lamports / 1e8;
// Price feed handlers
const priceHandlers = [
    { prefix: 'pythnet price:', label: 'Solana PythNet' },
    { prefix: 'doves price:', label: 'Solana Doves' }
];

// Process price from log entries
function processPrice(logEntry, { prefix, label }) {
    if (!logEntry.includes(prefix)) return null;
    const priceString = logEntry.split(prefix)[1]?.split(',')[0]?.trim();
    if (!priceString) return null;
    const price = Math.round(streamToUSDC(priceString) * 100) / 100;
    if (price > 100 && price < 300) { return price; } // Validate price range for SOL, 1500 and 3000 for ETH, 80000 and 110000 for BTC depending on current price
    return null;
}

let connection; // Solana connection instance
let subscriptionId; // WebSocket subscription ID

// Start price monitoring
async function startMonitoring() {
    if (connection && subscriptionId) {
        connection.removeOnLogsListener(subscriptionId); // Cleanup existing subscription
    }
    connection = await getConnection();
    // Throttle function to limit call frequency
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
    const throttledMonitorPrice = throttle(monitorPrice, 333); // Throttle to ~3 calls/sec

    // Subscribe to Solana logs
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
                // Average multiple price sources
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

// Calculate average EMA update frequency
function calculateAverageEMAUpdateCount(emaUpdateCounts) {
    if (emaUpdateCounts.length === 0) return 0;
    const totalEMAUpdates = emaUpdateCounts.reduce((sum, count) => sum + count, 0);
    return totalEMAUpdates / emaUpdateCounts.length;
}

// Main monitoring loop
async function monitorLogs() {
    // Display startup banner
    console.log('\x1b[32m%s\x1b[0m', `
    +-+-+-+-+-+-+-+-+-+-+-+-+
    |C|h|a|r|t|G|r|a|b|b|e|r|
    +-+-+-+-+-+-+-+-+-+-+-+-+`);
    await startMonitoring();
    // Check for price feed timeout
    setInterval(() => {
        if (Date.now() - lastPriceTime > PRICE_TIMEOUT) {
            console.log('No price updates for 1 minute, resubscribing...');
            if (connection && subscriptionId) { connection.removeOnLogsListener(subscriptionId); }
            startMonitoring();
        }
    }, PRICE_TIMEOUT);
    // Update EMA statistics
    setInterval(() => {
        emaUpdateCount = (updateCount * updateSmoothingFactor) + (emaUpdateCount * (1 - updateSmoothingFactor));
        emaUpdateCounts.push(emaUpdateCount);
        if (emaUpdateCounts.length > ROLLING_WINDOW_MINUTES) {
            emaUpdateCounts.shift(); // Maintain window size
        }
        averageEMAUpdateCount = calculateAverageEMAUpdateCount(emaUpdateCounts);
        console.log(`EMA Update Count: ${emaUpdateCount.toFixed(2)}`);
        updateCount = 0;
    }, 60000); // Every minute
}

// Start the bot
monitorLogs();
