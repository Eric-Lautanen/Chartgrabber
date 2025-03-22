// Remove all warning listeners from the process to prevent unwanted warning messages
process.removeAllListeners('warning');

// Import required modules
import dotenv from 'dotenv'; // For loading environment variables from .env file
import fetch from 'node-fetch'; // For making HTTP requests
dotenv.config(); // Load environment variables into process.env
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js'; // Solana blockchain utilities
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'; // SPL token utilities
import bs58 from 'bs58'; // Base58 encoding/decoding for Solana keys
import fs from 'fs'; // File system operations
import path from 'path'; // Path manipulation utilities
import { fileURLToPath } from 'url'; // Convert URL to file path for ES modules
import WebSocket from 'ws'; // WebSocket client for real-time price feeds

// Generate a unique session hash for connection identification
const SESSION_HASH = `CONNECTS${Math.ceil(Math.random() * 1e9)}`;

////////////// ONLY CHANGE THESE VARIABLES ///////////////
// Trading state and configuration variables
let alreadyBought = false; // Tracks if a buy has already occurred
const smoothingFactor = 0.05; // EMA smoothing factor (lower = smoother)
const BASE_POS_THRESHOLD = 0.007; // Base positive trend threshold (0.7%)
const BASE_NEG_THRESHOLD = -0.007; // Base negative trend threshold (-0.7%)
const MIN_THRESHOLD = 0.0065; // Minimum threshold for trend detection
const MAX_THRESHOLD = 0.008; // Maximum threshold for trend detection
const updateSmoothingFactor = 0.2; // Smoothing factor for EMA update count
let emaUpdateCount = 0; // Current EMA update frequency
const ROLLING_WINDOW_MINUTES = 15; // Time window for price history (15 minutes)
const MIN_DATA_TIME_MINUTES = 15; // Minimum runtime before trading (15 minutes)
const MIN_DATA_POINTS = 400; // Minimum price points before trading
const START_TIME = Date.now(); // Script start timestamp

// Adjustable baseline variables for swaps
const BASELINE_SLIPPAGE_UPTREND = 10; // Baseline slippage for uptrends (bps)
const BASELINE_SLIPPAGE_DOWNTREND = 20; // Baseline slippage for downtrends (bps)
const BASELINE_FEE_LAMPORTS = 500000; // Baseline transaction fee (0.0005 SOL)
const MAX_SLIPPAGE_BPS = 100; // Maximum slippage allowed (1%)
const MAX_FEE_LAMPORTS = 2000000; // Maximum transaction fee (0.002 SOL)
//////////////////////////////////////////////////////////

// Set up file paths for logging
const __filename = fileURLToPath(import.meta.url); // Current file path
const __dirname = path.dirname(__filename); // Current directory
const logDir = path.join(__dirname, 'logs'); // Logs directory path
if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); } // Create logs directory if it doesn't exist

// Log errors to file and console
function logError(error) {
    const timestamp = new Date().toISOString(); // Current timestamp
    const logEntry = `[${timestamp}] ERROR: ${error.stack}\n`; // Formatted error entry
    fs.appendFileSync(path.join(logDir, 'errors.log'), logEntry); // Append to errors.log
    console.error(error); // Log to console
}

// Wallet and token constants
const { decode } = bs58; // Base58 decode function
const WALLET_SECRET_KEY = process.env.PRVKEY; // Private key from .env
const walletAddress = process.env.PUBKEY; // Public key from .env
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // SOL token mint address
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC token mint address
const MIN_SOL_RESERVE = 0.005 * 1e9; // Minimum SOL to keep (0.005 SOL in lamports)
let AMOUNT_SOL = 0; // Current SOL balance in lamports
let AMOUNT_USDC = 0; // Current USDC balance
let lastBoughtPrice = null; // Last price at which SOL was bought
const colors = { reset: "\x1b[0m", fg: { gray: "\x1b[90m", green: "\x1b[32m", red: "\x1b[31m", blue: "\x1b[34m" } }; // ANSI color codes
let firstRun = true; // Flag for initial run
let startUp = true; // Flag for startup phase
let currentTrend = "none"; // Current market trend
let lastTrend = "none"; // Previous market trend
let trendCount = 0; // Consecutive trend confirmations
let updateCount = 0; // Price update counter
const emaUpdateCounts = []; // Rolling EMA update counts
let averageEMAUpdateCount = 0; // Average EMA update frequency
let lastPriceTime = Date.now(); // Last price update timestamp
const PRICE_TIMEOUT = 30 * 1000; // Price update timeout (30 seconds)

// Check for private key presence
if (!WALLET_SECRET_KEY) { console.error('Missing private key from environment variables.'); }

// Initialize wallet from secret key
let wallet;
try {
    const decodedSecretKey = decode(WALLET_SECRET_KEY); // Decode base58 secret key
    wallet = Keypair.fromSecretKey(decodedSecretKey); // Create Keypair object
} catch (error) {
    logError(error); // Log any wallet initialization errors
}

// Conversion utilities
function lamportsToSol(lamports) {
    const SOL_PER_LAMPORTS = 1000000000; // 1 SOL = 1e9 lamports
    return lamports / SOL_PER_LAMPORTS; // Convert lamports to SOL
}

function lamportsToUSDC(lamports) {
    const USDC_PER_LAMPORTS = 1000000; // 1 USDC = 1e6 lamports
    return lamports / USDC_PER_LAMPORTS; // Convert lamports to USDC
}

async function usdcToUSDC(usdcConvert) {
    if (typeof usdcConvert !== 'bigint') { throw new TypeError("Input must be a BigInt."); } // Type check
    if (usdcConvert > Number.MAX_SAFE_INTEGER || usdcConvert < Number.MIN_SAFE_INTEGER) {
        console.warn("BigInt value exceeds Number.MAX_SAFE_INTEGER/MIN_SAFE_INTEGER. Precision may be lost.");
    }
    return Number(usdcConvert); // Convert BigInt to Number
}

// Establish Solana network connection
async function getConnection() {
    const endpointUrls = [ // Array of RPC endpoints
        {
            http: 'https://solana-rpc.publicnode.com', // HTTP endpoint
            ws: 'wss://mainnet.helius-rpc.com/?api-key=', // WebSocket endpoint
            headers: { 'x-session-hash': SESSION_HASH }, // Custom headers
        },
        // Backup endpoint with same configuration
        {
            http: 'https://solana-rpc.publicnode.com',
            ws: 'wss://mainnet.helius-rpc.com/?api-key=',
            headers: { 'x-session-hash': SESSION_HASH },
        },
    ];
    for (const urlPair of endpointUrls) {
        try {
            const connection = new Connection(urlPair.http, { // Create new connection
                wsEndpoint: urlPair.ws, // WebSocket endpoint
                httpHeaders: urlPair.headers || {}, // Custom headers
                commitment: 'confirmed', // Confirmation level
            });
            await connection.getEpochInfo(); // Test connection
            return connection; // Return working connection
        } catch (error) {
            console.error(`Connection failed for ${urlPair.http} (ws: ${urlPair.ws}):`, error.message); // Log failure
        }
    }
    throw new Error("All combined HTTP/WebSocket connections are currently unavailable."); // All connections failed
}

// Update wallet balances
async function updateBalances() {
    try {
        const connection = await getConnection(); // Get Solana connection
        const publicKey = new PublicKey(walletAddress); // Convert wallet address to PublicKey
        const solBalance = await connection.getBalance(publicKey).catch(error => { // Get SOL balance
            console.error('SOL balance check failed:', error.message);
            return 0; // Return 0 on failure
        });
        let usdcBalance = 0; // Initialize USDC balance
        try {
            const associatedTokenAddress = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey); // Get USDC token account
            const account = await getAccount(connection, associatedTokenAddress); // Fetch account info
            usdcBalance = account.amount; // Get USDC amount
        } catch (error) {
            console.error('USDC balance check failed:', error.message); // Log USDC fetch error
        }
        AMOUNT_SOL = solBalance; // Update global SOL balance
        AMOUNT_USDC = await usdcToUSDC(usdcBalance); // Update global USDC balance
        console.log('          wallet updated'); // Log success
        console.log("----------------------------------");
    } catch (error) {
        console.log('Balance update failed:', error.message); // Log any errors
    }
}

// Fetch swap quote from Jupiter API
async function getQuote(inputMint, outputMint, amount, slippageBps) {
    try {
        const response = await fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true&onlyDirectRoutes=true`, // API endpoint
            { signal: AbortSignal.timeout(10000) } // 10-second timeout
        );
        if (!response.ok) throw new Error(`Failed to fetch quote: ${response.statusText}`); // Check response status
        const data = await response.json(); // Parse JSON response
        return data; // Return quote data
    } catch (error) {
        console.error('Error fetching quote:', error); // Log error
        throw error; // Rethrow for handling
    }
}

// Swap control variables
let isSwapInProgress = false; // Prevents concurrent swaps
const COOLDOWN_PERIOD = 60 * 1000; // 60-second cooldown between swaps

// Calculate dynamic slippage based on trend and volatility
async function getDynamicSlippageBps(isUptrend, attempt) {
    const baselineSlippage = isUptrend ? BASELINE_SLIPPAGE_UPTREND : BASELINE_SLIPPAGE_DOWNTREND; // Base slippage
    const recentPrices = priceHistory.slice(-10).map(entry => entry.price); // Last 10 prices
    
    if (recentPrices.length < 2 || attempt < 2) return baselineSlippage; // Use baseline if insufficient data
    
    const mean = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length; // Calculate mean
    const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length; // Calculate variance
    const volatility = Math.sqrt(variance); // Calculate standard deviation
    
    return Math.max(baselineSlippage, Math.min(MAX_SLIPPAGE_BPS, volatility * 1000)); // Adjust slippage within bounds
}

// Calculate dynamic transaction fee based on network conditions
async function getDynamicFee(connection, attempt) {
    const feeSteps = [BASELINE_FEE_LAMPORTS, 1000000, 1500000, MAX_FEE_LAMPORTS]; // Fee escalation steps
    const recentFees = await connection.getRecentPrioritizationFees(); // Get recent fees
    const avgFee = recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length || BASELINE_FEE_LAMPORTS; // Average fee

    const feeIndex = Math.min(Math.floor(attempt / 2), feeSteps.length - 1); // Determine fee step
    const fee = Math.max(avgFee, feeSteps[feeIndex]); // Choose higher of average or step
    
    return {
        maxLamports: fee, // Fee in lamports
        priorityLevel: fee > 1500000 ? "high" : fee > 1000000 ? "medium" : "low" // Priority label
    };
}

// Execute a token swap
async function swap(inputMint, outputMint, amount, isUptrend) {
    if (isSwapInProgress) { // Check for concurrent swaps
        console.error("Swap already in progress. Ignoring this call.");
        return;
    }
    isSwapInProgress = true; // Lock swap process

    try {
        if (!inputMint || !outputMint || !amount) { // Validate inputs
            throw new Error("Invalid input parameters for swap.");
        }

        const connection = await getConnection(); // Get Solana connection
        if (!connection || !wallet?.publicKey) throw new Error("Connection or wallet not initialized."); // Validate prerequisites

        let signature; // Transaction signature
        let attempt = 0; // Retry counter

        while (true) { // Retry loop
            try {
                const slippageBps = await getDynamicSlippageBps(isUptrend, attempt); // Get slippage
                const fee = await getDynamicFee(connection, attempt); // Get fee
                console.log(`Attempt ${attempt + 1}: Slippage=${slippageBps / 100}%, Fee=${fee.maxLamports / 1e9} SOL`); // Log attempt details

                const quoteResponse = await getQuote(inputMint, outputMint, amount, slippageBps); // Fetch quote
                if (!quoteResponse) throw new Error("Failed to fetch quote."); // Validate quote

                const swapResponse = await fetch('https://api.jup.ag/swap/v1/swap', { // Execute swap
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        quoteResponse,
                        userPublicKey: wallet.publicKey.toString(),
                        dynamicComputeUnitLimit: true,
                        slippageBps,
                        prioritizationFeeLamports: fee
                    }),
                    signal: AbortSignal.timeout(10000) // 10-second timeout
                });

                if (!swapResponse.ok) { // Check API response
                    const errorBody = await swapResponse.text();
                    throw new Error(`API Error: ${errorBody}`);
                }

                const swapData = await swapResponse.json(); // Parse swap response
                if (!swapData?.swapTransaction) throw new Error("Missing swapTransaction in response."); // Validate data

                const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64')); // Deserialize transaction
                transaction.sign([wallet]); // Sign with wallet

                signature = await connection.sendRawTransaction(transaction.serialize(), { // Send transaction
                    maxRetries: 2,
                    skipPreflight: false
                });

                console.log(`Transaction succeeded: https://solscan.io/tx/${signature}`); // Log success
                break; // Exit retry loop

            } catch (error) {
                attempt++; // Increment attempt counter
                console.error(`Swap attempt ${attempt} failed: ${error.message}`); // Log failure
                if (attempt === 1) {
                    console.log("First attempt failed, increasing fees...");
                } else if (attempt === 2) {
                    console.log("Second attempt failed, adjusting slippage...");
                } else {
                    console.log(`Attempt ${attempt + 1}: Escalating fees/slippage...`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.min(attempt, 5))); // Exponential backoff
            }
        }

        await retryUntilSuccess(async () => { // Update balances after swap
            await updateBalances();
            console.log("Balances updated successfully.");
        });

        return signature; // Return transaction signature

    } catch (error) {
        console.error("Unexpected error in swap logic:", error); // Log unexpected errors
        throw error; // Rethrow for handling
    } finally {
        setTimeout(() => { // Reset swap lock after cooldown
            isSwapInProgress = false;
            console.log("Swap cooldown period over. Resetting to baseline values.");
        }, COOLDOWN_PERIOD);
    }
}

// Retry a function until it succeeds
async function retryUntilSuccess(fn, retryDelay = 3000) {
    while (true) {
        try {
            await fn(); // Attempt execution
            break; // Exit on success
        } catch (error) {
            console.error("Retryable error:", error); // Log error
            if (error.message && error.message.includes("Simulation failed")) { // Check for fatal error
                console.error("Stopping retries due to 'Simulation failed' error.");
                break;
            }
            console.log(`Retrying in ${retryDelay / 1000} seconds...`); // Log retry
            await new Promise(resolve => setTimeout(resolve, retryDelay)); // Wait before retry
        }
    }
}

// EMA and price history management
let priceHistory = []; // Array of price entries with timestamps
let ema = null; // Current EMA value
let previousEma = null; // Previous EMA value

// Calculate Exponential Moving Average
function calculateRollingEMA(previousEMA, currentPrice, smoothingFactor) {
    return (currentPrice * smoothingFactor) + (previousEMA * (1 - smoothingFactor)); // EMA formula
}

// Determine market trend based on price and EMA
async function checkTrend(currentPrice) {
    const currentTime = Date.now(); // Current timestamp
    priceHistory.push({ price: currentPrice, timestamp: currentTime }); // Add new price entry

    const rollingWindowStart = currentTime - (ROLLING_WINDOW_MINUTES * 60 * 1000); // Window start time
    priceHistory = priceHistory.filter(entry => entry.timestamp >= rollingWindowStart); // Trim old entries

    if (priceHistory.length === 0) return; // Exit if no data

    const totalRuntimeMinutes = (currentTime - START_TIME) / (60 * 1000); // Runtime in minutes
    const hasEnoughData = totalRuntimeMinutes >= MIN_DATA_TIME_MINUTES && priceHistory.length >= MIN_DATA_POINTS; // Check data sufficiency

    if (!hasEnoughData) { // Wait for sufficient data
        console.log(`Waiting for more data: ${priceHistory.length} points, ${totalRuntimeMinutes.toFixed(1)} minutes since start`);
        currentTrend = "none";
        trendCount = 0;
        return;
    }

    if (ema === null) { // Initialize EMA on first run
        ema = currentPrice;
        previousEma = ema;
        console.log(`Initial EMA: ${ema.toFixed(5)}`);
        return;
    }

    ema = calculateRollingEMA(previousEma, currentPrice, smoothingFactor); // Update EMA
    console.log(`EMA: ${ema.toFixed(5)}`);
    console.log('avgPriceUpdateCount:', averageEMAUpdateCount);

    const netChange = (previousEma !== 0 && !isNaN(ema) && !isNaN(previousEma)) // Calculate percentage change
        ? (((ema - previousEma) / previousEma) * 100)
        : 0;
    console.log(`Net Change: ${netChange.toFixed(5)}%`);

    const volatilityFactor = emaUpdateCount / (averageEMAUpdateCount || 1); // Adjust thresholds by volatility
    let posThreshold = Math.min(Math.max(BASE_POS_THRESHOLD / (volatilityFactor + 0.1), MIN_THRESHOLD), MAX_THRESHOLD); // Dynamic positive threshold
    let negThreshold = Math.max(Math.min(BASE_NEG_THRESHOLD / (volatilityFactor + 0.1), -MIN_THRESHOLD), -MAX_THRESHOLD); // Dynamic negative threshold

    console.log(`Thresholds: pos=${posThreshold.toFixed(5)}, neg=${negThreshold.toFixed(5)}`);
    console.log(`Volatility Factor: ${volatilityFactor.toFixed(2)}`);

    if (netChange > posThreshold && priceHistory.length > 1) { // Detect upward trend
        if (trendCount >= 2) {
            currentTrend = "pos"; // Confirm trend after 3 consecutive signals
        }
        trendCount++;
        console.log(`${colors.fg.green}Upward trend detected!${colors.reset}`);
    } else if (netChange < negThreshold && priceHistory.length > 1) { // Detect downward trend
        if (trendCount >= 2) {
            currentTrend = "neg"; // Confirm trend after 3 consecutive signals
        }
        trendCount++;
        console.log(`${colors.fg.red}Downward trend detected!${colors.reset}`);
    } else { // No trend
        trendCount = 0;
        console.log(`${colors.fg.gray}No trend detected.${colors.reset}`);
    }
    console.log("----------------------------------");
    previousEma = ema; // Update previous EMA
}

// Calculate percentage of a number
async function getPercentage(number, percentage) {
    if (typeof number !== 'number' || typeof percentage !== 'number') { return "Invalid input. Please provide numbers."; } // Type check
    if (percentage < 0 || percentage > 100) { return "Invalid percentage. Please provide a value between 0 and 100."; } // Range check
    return (number * percentage) / 100; // Calculate percentage
}

let lastUpdateMinute = -1; // Last minute balances were updated

// Monitor price and execute trades
async function monitorPrice(price) {
    lastPriceTime = Date.now(); // Update last price timestamp
    updateCount++; // Increment update counter
    try {
        if (startUp) { // Initial startup
            await updateBalances(); // Fetch initial balances
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`); // Log balances
            startUp = false; // End startup phase
        } else {
            console.log(`[${new Date().toISOString()}] SOL/USD Price: ${price}`); // Log current price
            console.log('USDCL:', AMOUNT_USDC, 'SOLL:', AMOUNT_SOL); // Log balances in lamports
            console.log('lastBoughtPrice:', lastBoughtPrice); // Log last buy price
            console.log(`USDC: \x1b[36m${lamportsToUSDC(AMOUNT_USDC)}\x1b[0m SOL: \x1b[36m${lamportsToSol(AMOUNT_SOL)}\x1b[0m`); // Log formatted balances
            console.log('swapInProgress:', isSwapInProgress, 'currentTrend:', currentTrend); // Log swap and trend status
            await checkTrend(Number(price)); // Analyze trend

            const currentMinute = new Date().getMinutes(); // Current minute
            if (currentMinute % 5 === 0 && currentMinute !== lastUpdateMinute) { // Update balances every 5 minutes
                await retryUntilSuccess(() => updateBalances());
                lastUpdateMinute = currentMinute; // Update last update minute
            }

            if (currentTrend === "pos" && !isSwapInProgress && !alreadyBought) { // Buy condition
                if (lastTrend === "pos") return; // Skip if already in uptrend
                lastBoughtPrice = price; // Record buy price
                const compoundDaUSDC = Math.round(AMOUNT_USDC * 0.999); // Use 99.9% of USDC
                const didSwap = await swap(USDC_MINT, SOL_MINT, compoundDaUSDC, true); // Execute buy
                console.log("BUY");
                console.log("----------------------------------");
                if (didSwap) lastTrend = "pos"; // Update trend on success
                firstRun = false; // End first run
            } else if (currentTrend === "neg" && !firstRun && !isSwapInProgress) { // Sell condition
                if (lastTrend === "neg") return; // Skip if already in downtrend
                console.log("SELL");
                console.log("----------------------------------");
                const tradableSOL = AMOUNT_SOL - MIN_SOL_RESERVE; // Calculate tradable SOL
                const swapSOLtoUSDC = Math.round(tradableSOL); // Round to integer
                if (swapSOLtoUSDC > 0) { // Check if enough SOL to sell
                    await swap(SOL_MINT, USDC_MINT, swapSOLtoUSDC, false); // Execute sell
                    console.log("SELL - Swapped all tradable SOL, leaving 0.005 SOL");
                }
                alreadyBought = false; // Reset buy flag
                lastTrend = "neg"; // Update trend
            }
        }
    } catch (error) {
        logError(error); // Log any errors
    }
}

// Price fetching variables
let latestKrakenPrice = null; // Latest price from Kraken
let latestCoinbasePrice = null; // Latest price from Coinbase
let latestJupiterPrice = null; // Latest price from Jupiter
let lastUsedPrice = null; // Last price used for monitoring
let lastKrakenUpdate = 0; // Last Kraken update timestamp
let lastCoinbaseUpdate = 0; // Last Coinbase update timestamp

// Connect to Kraken WebSocket for real-time prices
function connectKrakenWebSocket() {
    const ws = new WebSocket('wss://ws.kraken.com'); // Initialize WebSocket

    ws.on('open', () => { // On connection open
        ws.send(JSON.stringify({ // Subscribe to SOL/USD trade data
            event: 'subscribe',
            pair: ['SOL/USD'],
            subscription: { name: 'trade' }
        }));
    });

    ws.on('message', (data) => { // Handle incoming messages
        const msg = JSON.parse(data);
        if (msg.event) return; // Ignore non-trade messages
        if (Array.isArray(msg) && msg.length > 1) {
            const tradeData = msg[1];
            if (tradeData && tradeData.length > 0) {
                const price = Number(tradeData[0][0]); // Extract price
                if (!isNaN(price)) {
                    latestKrakenPrice = price; // Update price
                    lastKrakenUpdate = Date.now(); // Update timestamp
                } else {
                    console.error('Kraken: Invalid price in trade data', tradeData); // Log invalid data
                }
            }
        }
    });

    ws.on('error', (error) => { // Handle errors
        console.error('Kraken WebSocket error:', error.message);
    });

    ws.on('close', () => { // Handle closure
        console.warn('Kraken WebSocket closed, reconnecting in 1s...');
        setTimeout(connectKrakenWebSocket, 1000); // Reconnect after 1 second
    });

    return ws; // Return WebSocket instance
}

// Connect to Coinbase WebSocket for real-time prices
function connectCoinbaseWebSocket() {
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); // Initialize WebSocket

    ws.on('open', () => { // On connection open
        ws.send(JSON.stringify({ // Subscribe to SOL-USD ticker
            type: 'subscribe',
            product_ids: ['SOL-USD'],
            channels: ['ticker']
        }));
    });

    ws.on('message', (data) => { // Handle incoming messages
        const msg = JSON.parse(data);
        if (msg.type === 'ticker' && msg.price) {
            const price = Number(msg.price); // Extract price
            if (!isNaN(price)) {
                latestCoinbasePrice = price; // Update price
                lastCoinbaseUpdate = Date.now(); // Update timestamp
            } else {
                console.error('Coinbase: Invalid price in ticker data', msg); // Log invalid data
            }
        }
    });

    ws.on('error', (error) => { // Handle errors
        console.error('Coinbase WebSocket error:', error.message);
    });

    ws.on('close', () => { // Handle closure
        console.warn('Coinbase WebSocket closed, reconnecting in 1s...');
        setTimeout(connectCoinbaseWebSocket, 1000); // Reconnect after 1 second
    });

    return ws; // Return WebSocket instance
}

// Fetch SOL price from Jupiter API
async function getJupiterPrice() {
    try {
        const response = await fetch( // Request price data
            'https://price.jup.ag/v4/price?ids=SOL&vsToken=USDC',
            { signal: AbortSignal.timeout(5000) } // 5-second timeout
        );
        if (!response.ok) throw new Error(`Jupiter API error: ${response.statusText}`); // Check response
        const data = await response.json(); // Parse JSON
        const price = Number(Number(data.data.SOL.price).toFixed(2)); // Round to 2 decimals
        if (!isNaN(price)) {
            latestJupiterPrice = price; // Update price
            return price; // Return price
        } else {
            console.error('Jupiter: Invalid price in response', data); // Log invalid data
            return null;
        }
    } catch (error) {
        console.error('Error fetching Jupiter price:', error.message); // Log error
        return null;
    }
}

// Start price monitoring from multiple sources
function startPriceMonitoring() {
    let krakenWs = connectKrakenWebSocket(); // Start Kraken WebSocket
    let coinbaseWs = connectCoinbaseWebSocket(); // Start Coinbase WebSocket

    // Jupiter fallback polling every 5 seconds
    setInterval(async () => {
        const now = Date.now();
        const STALE_THRESHOLD = 30000; // 30-second staleness threshold
        const isKrakenStale = latestKrakenPrice !== null && (now - lastKrakenUpdate > STALE_THRESHOLD); // Check Kraken staleness
        const isCoinbaseStale = latestCoinbasePrice !== null && (now - lastCoinbaseUpdate > STALE_THRESHOLD); // Check Coinbase staleness

        if ((latestKrakenPrice === null || isKrakenStale) && (latestCoinbasePrice === null || isCoinbaseStale)) { // Use Jupiter if both are stale
            const jupiterPrice = await getJupiterPrice();
            if (jupiterPrice !== null && jupiterPrice !== lastUsedPrice) {
                monitorPrice(jupiterPrice); // Monitor Jupiter price
                lastUsedPrice = jupiterPrice; // Update last used price
            }
        }
    }, 5000);

    // Handle Kraken price updates (duplicate handler for clarity)
    krakenWs.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.event) return;
        if (Array.isArray(msg) && msg.length > 1) {
            const tradeData = msg[1];
            if (tradeData && tradeData.length > 0) {
                const price = Number(tradeData[0][0]);
                if (!isNaN(price)) {
                    latestKrakenPrice = price;
                    lastKrakenUpdate = Date.now();
                    updatePrice(); // Update price logic
                }
            }
        }
    });

    // Handle Coinbase price updates (duplicate handler for clarity)
    coinbaseWs.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'ticker' && msg.price) {
            const price = Number(msg.price);
            if (!isNaN(price)) {
                latestCoinbasePrice = price;
                lastCoinbaseUpdate = Date.now();
                updatePrice(); // Update price logic
            }
        }
    });

    // Update price based on available sources
    function updatePrice() {
        let priceToUse = null;
        if (latestKrakenPrice !== null && latestCoinbasePrice !== null) { // Average if both available
            priceToUse = Number(((latestKrakenPrice + latestCoinbasePrice) / 2).toFixed(2));
        } else if (latestKrakenPrice !== null) { // Use Kraken if available
            priceToUse = latestKrakenPrice;
        } else if (latestCoinbasePrice !== null) { // Use Coinbase if available
            priceToUse = latestCoinbasePrice;
        }

        if (priceToUse !== null && !isNaN(priceToUse) && priceToUse !== lastUsedPrice) { // Update if valid and new
            monitorPrice(priceToUse);
            lastUsedPrice = priceToUse;
        }
    }
}

// Calculate average EMA update count
function calculateAverageEMAUpdateCount(emaUpdateCounts) {
    if (emaUpdateCounts.length === 0) return 0; // Return 0 if no data
    const totalEMAUpdates = emaUpdateCounts.reduce((sum, count) => sum + count, 0); // Sum updates
    return totalEMAUpdates / emaUpdateCounts.length; // Calculate average
}

// Main monitoring function
async function monitorLogs() {
    console.log('\x1b[32m%s\x1b[0m', ` // Display startup banner
    +-+-+-+-+-+-+-+-+-+-+-+-+
    |C|h|a|r|t|G|r|a|b|b|e|r|
    +-+-+-+-+-+-+-+-+-+-+-+-+`);
    
    startPriceMonitoring(); // Start price feeds

    setInterval(() => { // Check for price update timeouts
        if (Date.now() - lastPriceTime > PRICE_TIMEOUT) {
            console.log('No price updates for 30 seconds, check connections...');
        }
    }, PRICE_TIMEOUT);

    setInterval(() => { // Update EMA frequency every minute
        emaUpdateCount = (updateCount * updateSmoothingFactor) + (emaUpdateCount * (1 - updateSmoothingFactor)); // Smooth EMA count
        emaUpdateCounts.push(emaUpdateCount); // Add to history
        if (emaUpdateCounts.length > ROLLING_WINDOW_MINUTES) { // Trim history
            emaUpdateCounts.shift();
        }
        averageEMAUpdateCount = calculateAverageEMAUpdateCount(emaUpdateCounts); // Update average
        console.log(`EMA Update Count: ${emaUpdateCount.toFixed(2)}`);
        updateCount = 0; // Reset counter
    }, 60000);
}

monitorLogs(); // Start the monitoring process
