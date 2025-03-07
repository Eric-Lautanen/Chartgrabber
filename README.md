This is a Solana trading bot that:

Monitors SOL/USDC price using multiple feeds
Uses EMA (Exponential Moving Average) to detect trends
Automatically buys SOL when an upward trend is detected
Sells SOL when a downward trend is detected
Integrates with Jupiter API for swapping tokens
Maintains minimum SOL reserves
Includes error handling and retry logic
Logs activities and errors to file
You can tweak it for ETH or BTC on the SOL network
It grabs current SOL price from Pythnet and Dove on blockchain price Oracles no need for DEX or CEX apis for prices.
