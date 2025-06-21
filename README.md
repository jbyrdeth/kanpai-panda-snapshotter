# Kanpai Panda Snapshotter

A tool to snapshot NFT holders for Kanpai Panda collections across multiple blockchains.

## What it does

- **Infinity Collection**: 250 NFTs on Ethereum
- **Panda Collection**: 9,000 NFTs across 7 chains (Ethereum, Arbitrum, Optimism, BSC, Polygon, Fantom, Avalanche)
- **Solana Panda Collection**: NFTs on Solana blockchain

## Setup

1. **Install Node.js** (version 14 or higher)

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   - Copy `env.example` to `.env`
   - Add your API keys:
     - `MORALIS_API_KEY` - Get from [moralis.io](https://moralis.io)
     - `HELIUS_API_KEY` - Get from [helius.xyz](https://helius.xyz)
     - `ETH_RPC_URL` - Get from [alchemy.com](https://alchemy.com) or [infura.io](https://infura.io)

## Usage

Run the snapshotter:
```bash
node kanpai_snapshotter.js
```

Choose from the menu:
1. Infinity Collection snapshot
2. Panda Collection snapshot  
3. Solana Panda Collection snapshot
4. Run all snapshots
5. Exit

## Output

Creates CSV files with holder addresses and token counts:
- `infinity_holders_YYYY-MM-DD.csv`
- `panda_holders_YYYY-MM-DD.csv` 
- `solana_panda_holders_YYYY-MM-DD.csv`

**Note**: The tool automatically removes old CSV files before creating new ones to ensure you always have the latest snapshot data.

## Requirements

- Node.js 14+
- Moralis API key (for Ethereum/EVM chains)
- Helius API key (for Solana)
<<<<<<< HEAD
- Ethereum RPC URL 
=======
- Ethereum RPC URL
>>>>>>> ac288e2b3dd0171db0187b7b35a447099e26c209
