# 🐼 Kanpai Panda Snapshotter

A powerful multi-blockchain NFT holder snapshotter tool for Kanpai Panda collections. Capture precise ownership data across multiple blockchains at any point in time for airdrops, governance, and holder verification.

## 🎯 What It Does

This tool creates comprehensive CSV reports showing **who owns what NFTs** across three distinct Kanpai Panda collections:

| Collection | Supply | Blockchains | Contract Address |
|------------|--------|-------------|------------------|
| **Infinity** | 250 NFTs | Ethereum | `0x7Db7A0f8971C5d57F1ee44657B447D5D053B6bAE` |
| **Panda** | 9,000 NFTs | 7 Chains* | `0xaCF63E56fd08970b43401492a02F6F38B6635C91` |
| **Solana Panda** | Variable | Solana | *Uses mint address mapping* |

*Supported chains: Ethereum, Arbitrum, Optimism, BSC, Polygon, Fantom, Avalanche

## ✨ Key Features

- 🔗 **Multi-chain support** - Works across 8 different blockchains
- 📸 **Historical snapshots** - Capture ownership at any past block/timestamp
- 🔄 **Batch processing** - Efficient processing with configurable batch sizes
- 🛡️ **Robust error handling** - Automatic retries and rate limit management
- 🧹 **Clean data management** - Automatically removes old snapshots
- 📊 **Comprehensive reporting** - Detailed CSV outputs with ownership analytics

## 🚀 Quick Start

### Prerequisites

- **Node.js** (v14 or higher)
- **API Keys** (see configuration section)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd kanpai-panda-snapshotter
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp env.example .env
   # Edit .env with your API keys
   ```

4. **Run the snapshotter**
   ```bash
   npm start
   ```

## ⚙️ Configuration

### Required Environment Variables

Create a `.env` file with the following:

```bash
# REQUIRED - Blockchain API Access
MORALIS_API_KEY=your_moralis_api_key_here
HELIUS_API_KEY=your_helius_api_key_here
ETH_RPC_URL=your_ethereum_rpc_url_here

# OPTIONAL - Additional Chain RPCs
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
OPTIMISM_RPC_URL=https://mainnet.optimism.io
BSC_RPC_URL=https://bsc-dataseed1.binance.org
POLYGON_RPC_URL=https://polygon-rpc.com
FANTOM_RPC_URL=https://rpc.ftm.tools
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc

# OPTIONAL - Performance Tuning
BATCH_SIZE=25
MAX_CONCURRENT=30
RETRY_DELAY=200
```

### Where to Get API Keys

| Service | Purpose | Get Key |
|---------|---------|---------|
| **Moralis** | EVM chain data & block resolution | [moralis.io](https://moralis.io) |
| **Helius** | Solana blockchain queries | [helius.xyz](https://helius.xyz) |
| **Alchemy/Infura** | Ethereum RPC access | [alchemy.com](https://alchemy.com) or [infura.io](https://infura.io) |

## 🎮 Usage

### Interactive Menu

Run the snapshotter and choose from the menu:

```bash
npm start
```

```
=============================================================
🐼 Kanpai Panda Multi-Chain NFT Snapshotter
=============================================================

Select a snapshotter to run:

1. Infinity NFT Snapshotter (Ethereum Only)
   - 250 NFTs on Ethereum
   - Contract: 0x7Db7A0f8971C5d57F1ee44657B447D5D053B6bAE

2. Panda Multi-Chain Snapshotter
   - 9,000 NFTs across 7 chains
   - Contract: 0xaCF63E56fd08970b43401492a02F6F38B6635C91

3. Solana Panda Snapshotter
   - Reads from Solana Panda IDs.csv
   - Uses Helius API for Solana blockchain

4. Run All Snapshotters (Sequential)

5. Exit
```

### Command Line Options

You can also use the tool programmatically:

```javascript
const { KanpaiSnapshotter } = require('./kanpai_snapshotter.js');

const snapshotter = new KanpaiSnapshotter();
await snapshotter.runInfinitySnapshotter();
```

## 📊 Output Format

The tool generates timestamped CSV files with the following structure:

### Standard Output
```csv
TokenId,Owner,Chain,BlockNumber
1,0xAbE635A453Db40eB18c26b28C6AD624127745faD,ethereum,22767816
2,0x428ED7c65Aa0deff25D8455899f585308dd43651,ethereum,22767816
...
```

### Generated Files
- `Infinity Holders YYYY-MM-DD.csv`
- `Panda Holders YYYY-MM-DD.csv`
- `Solana Panda Holders YYYY-MM-DD.csv`

## 🔧 Advanced Configuration

### Performance Tuning

Adjust these environment variables based on your API limits:

```bash
BATCH_SIZE=25          # Tokens processed per batch
MAX_CONCURRENT=30      # Concurrent requests
RETRY_DELAY=200        # Delay between retries (ms)
```

### Custom Contract Addresses

Override default contract addresses:

```bash
CONTRACT_ADDRESS=0xYourCustomContractAddress
TOTAL_SUPPLY=9000
```

## 🛠️ How It Works

### 1. Block Synchronization
- Uses Moralis API to get block numbers for the same timestamp across chains
- Ensures consistent snapshot timing across all blockchains

### 2. Ownership Detection
- **EVM Chains**: Calls `ownerOf(tokenId)` on NFT contracts using ethers.js
- **Solana**: Queries token account ownership via Helius RPC API

### 3. Multi-Chain Processing
- Checks the same token ID across all supported chains
- Records which specific chain holds each token
- Creates comprehensive cross-chain ownership mapping

### 4. Data Management
- Processes tokens in configurable batches with retry logic
- Implements rate limiting to respect API limits
- Automatically cleans up old snapshot files

## 🐛 Troubleshooting

### Common Issues

**"Missing required environment variables"**
- Ensure all required API keys are set in your `.env` file

**"Rate limited" errors**
- Increase `RETRY_DELAY` and/or decrease `MAX_CONCURRENT`

**"No valid data found"**
- For Solana snapshots, ensure `Solana Panda IDs.csv` exists and has valid data

**Chain connection errors**
- Verify your RPC URLs are working and have sufficient rate limits

### Performance Tips

- Use paid API plans for better rate limits
- Adjust batch sizes based on your API tier
- Run snapshots during off-peak hours for better performance

## 📝 File Structure

```
kanpai-panda-snapshotter/
├── kanpai_snapshotter.js    # Main application
├── Solana Panda IDs.csv     # Solana mint address mapping
├── package.json             # Dependencies
├── env.example              # Environment template
└── README.md               # This file
```
