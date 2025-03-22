# Solana Trading Bot

This script is a Solana trading bot designed to automatically buy and sell SOL based on real-time price trends. It utilizes WebSocket connections to Kraken and Coinbase for price feeds and the Jupiter Aggregator API for executing swaps.

## Features

-   **Real-time Price Monitoring**: Uses WebSocket connections to Kraken and Coinbase for live price updates, with Jupiter API as a fallback.
-   **Trend Analysis**: Calculates Exponential Moving Average (EMA) to identify market trends.
-   **Dynamic Slippage and Fee Calculation**: Adjusts slippage and transaction fees based on market volatility and network conditions.
-   **Automated Trading**: Executes buy and sell orders based on detected trends.
-   **Error Handling and Logging**: Logs errors to a file and retries failed transactions.
-   **Balance Management**: Monitors and updates Solana and USDC balances.
-   **Configurable Parameters**: Allows customization of trading thresholds, slippage, and fees.

## Prerequisites

-   Node.js (version 16 or higher)
-   npm or yarn
-   Solana wallet with SOL and USDC tokens
-   Environment variables set for wallet private and public keys
-   API keys for WebSocket price feed providers (Kraken, Coinbase, Jupiter)

## Installation

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd <repository_directory>
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

    or

    ```bash
    yarn install
    ```

3.  **Set up environment variables:**

    Create a `.env` file in the project root directory with the following variables:

    ```
    PRVKEY=<your_private_key>
    PUBKEY=<your_public_key>
    ```

    Replace `<your_private_key>` and `<your_public_key>` with your Solana wallet's private and public keys, respectively.

4.  **Configuration:**

    Modify the configuration variables in the script to suit your trading strategy. Key variables include:

    -   `BASE_POS_THRESHOLD`: Base positive trend threshold.
    -   `BASE_NEG_THRESHOLD`: Base negative trend threshold.
    -   `MIN_THRESHOLD`: Minimum threshold for trend detection.
    -   `MAX_THRESHOLD`: Maximum threshold for trend detection.
    -   `BASELINE_SLIPPAGE_UPTREND`: Baseline slippage for uptrends.
    -   `BASELINE_SLIPPAGE_DOWNTREND`: Baseline slippage for downtrends.
    -   `BASELINE_FEE_LAMPORTS`: Baseline transaction fee.
    -   `MIN_SOL_RESERVE`: Minimum SOL to keep in wallet.
    -   `ROLLING_WINDOW_MINUTES`: Time window for price history.
    -   `MIN_DATA_TIME_MINUTES`: Minimum runtime before trading.
    -   `MIN_DATA_POINTS`: Minimum price points before trading.

## Usage

1.  **Run the script:**

    ```bash
    node <script_filename>.js
    ```

    Replace `<script_filename>.js` with the actual name of your script file.

2.  **Monitoring:**

    The script will log real-time price updates, trend analysis, and trading actions to the console. Errors are logged to `logs/errors.log`.

## Script Overview

-   **`process.removeAllListeners('warning')`**: Removes all warning listeners to prevent unwanted warning messages.
-   **Environment Variables**: Loads environment variables from a `.env` file.
-   **Solana Connection**: Establishes a connection to the Solana network.
-   **Balance Management**: Fetches and updates SOL and USDC balances.
-   **Price Monitoring**: Connects to Kraken and Coinbase WebSocket feeds and fetches prices from Jupiter API.
-   **Trend Analysis**: Calculates EMA and detects market trends.
-   **Swap Execution**: Executes buy and sell orders using the Jupiter Aggregator API.
-   **Error Handling**: Logs errors and retries failed transactions.
-   **Dynamic Slippage and Fee**: Calculates and adjusts slippage and fees based on market conditions.
-   **Logging**: Logs all actions and errors to the console and files.

## Dependencies

-   `dotenv`: For loading environment variables.
-   `node-fetch`: For making HTTP requests.
-   `@solana/web3.js`: Solana blockchain utilities.
-   `@solana/spl-token`: SPL token utilities.
-   `bs58`: Base58 encoding/decoding.
-   `fs`: File system operations.
-   `path`: Path manipulation utilities.
-   `url`: URL manipulation utilities.
-   `ws`: WebSocket client.

## Disclaimer

This script is provided as-is and is intended for educational purposes only. Trading cryptocurrencies involves significant risk. Use this script at your own risk. The author is not responsible for any financial losses incurred.
