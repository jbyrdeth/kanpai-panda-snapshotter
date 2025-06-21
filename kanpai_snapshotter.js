const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const readline = require("readline");
require('dotenv').config();

// Utility function for rate limiting and delays
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// Environment validation
function validateEnvironment() {
  const requiredVars = ['MORALIS_API_KEY'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

// Configuration constants
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "200");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "25");
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "30");

// Contract configurations
const CONTRACTS = {
  infinity: {
    address: "0x7Db7A0f8971C5d57F1ee44657B447D5D053B6bAE",
    totalSupply: 250,
    chain: "ethereum"
  },
  panda: {
    address: process.env.CONTRACT_ADDRESS || "0xaCF63E56fd08970b43401492a02F6F38B6635C91",
    totalSupply: parseInt(process.env.TOTAL_SUPPLY || "9000"),
    chains: ["ethereum", "arbitrum", "optimism", "bsc", "polygon", "fantom", "avalanche"]
  },
  solanaPanda: {
    inputFile: "Solana Panda Earnings.csv",
    heliusRpc: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  }
};

// Chain configurations for multi-chain support
const moralisChains = {
  ethereum: "eth",
  arbitrum: "arbitrum", 
  optimism: "optimism",
  bsc: "bsc",
  polygon: "polygon",
  fantom: "fantom",
  avalanche: "avalanche",
};

const chains = {
  ethereum: { rpc: process.env.ETH_RPC_URL, chainId: 1, snapshotBlock: null },
  arbitrum: { rpc: process.env.ARBITRUM_RPC_URL, chainId: 42161, snapshotBlock: null },
  optimism: { rpc: process.env.OPTIMISM_RPC_URL, chainId: 10, snapshotBlock: null },
  bsc: { rpc: process.env.BSC_RPC_URL, chainId: 56, snapshotBlock: null },
  polygon: { rpc: process.env.POLYGON_RPC_URL, chainId: 137, snapshotBlock: null },
  fantom: { rpc: process.env.FANTOM_RPC_URL, chainId: 250, snapshotBlock: null },
  avalanche: { rpc: process.env.AVALANCHE_RPC_URL, chainId: 43114, snapshotBlock: null },
};

// Minimal ERC-721 ABI
const abi = ["function ownerOf(uint256 tokenId) view returns (address)"];

// Provider management
const providerCache = new Map();

function getProvider(chainName, chainConfig) {
  if (!providerCache.has(chainName)) {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpc, {
      chainId: chainConfig.chainId,
      name: chainName
    });
    providerCache.set(chainName, provider);
  }
  return providerCache.get(chainName);
}

/**
 * Get the block number for a given chain and Unix timestamp using Moralis API.
 */
async function getBlockForTimestamp(moralisChain, timestamp) {
  const url = `https://deep-index.moralis.io/api/v2.2/dateToBlock?chain=${moralisChain}&date=${timestamp}`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        "X-API-Key": MORALIS_API_KEY,
        Accept: "application/json",
      },
    });
    return response.data.block;
  } catch (err) {
    console.error(`Error fetching block for ${moralisChain}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * INFINITY SNAPSHOTTER CLASS
 */
class InfinitySnapshotter {
  constructor() {
    this.contractAddress = CONTRACTS.infinity.address;
    this.totalSupply = CONTRACTS.infinity.totalSupply;
    this.batchSize = BATCH_SIZE;
  }

  async getTokenOwnerBatch(snapshotBlock, tokenIds) {
    const provider = getProvider("ethereum", chains.ethereum);
    const contract = new ethers.Contract(this.contractAddress, abi, provider);
    
    return await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const owner = await contract.ownerOf(tokenId, { blockTag: snapshotBlock });
          return { tokenId, owner };
        } catch (err) {
          return { tokenId, owner: null };
        }
      })
    );
  }

  async snapshotNFTs(snapshotBlock) {
    const finalSnapshot = {};
    const startTime = Date.now();
    const tokensToRecheck = new Set();
    let totalFound = 0;

    console.log(`Starting to process ${this.totalSupply} Infinity tokens at block ${snapshotBlock}...`);
    
    // Create batches of token IDs
    const batches = [];
    for (let i = 1; i <= this.totalSupply; i += this.batchSize) {
      const batch = [];
      for (let j = 0; j < this.batchSize && i + j <= this.totalSupply; j++) {
        batch.push(i + j);
      }
      batches.push(batch);
    }
    
    // Process each batch
    for (const batch of batches) {
      const batchStart = Math.min(...batch);
      const batchEnd = Math.max(...batch);
      console.log(`\nProcessing batch ${batchStart}-${batchEnd}...`);
      
      const results = await this.getTokenOwnerBatch(snapshotBlock, batch);
      
      for (const result of results) {
        if (result.owner && result.owner !== ethers.ZeroAddress) {
          console.log(`✅ Found Token ${result.tokenId} | Owner: ${result.owner}`);
          finalSnapshot[result.tokenId] = {
            owner: result.owner,
            block: snapshotBlock
          };
          totalFound++;
        } else {
          console.log(`❌ Token ${result.tokenId} not found`);
          tokensToRecheck.add(result.tokenId);
        }
      }
      
      const processedTokens = Math.min(batchEnd, this.totalSupply);
      const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
      const progress = ((processedTokens / this.totalSupply) * 100).toFixed(2);
      console.log(`Progress: ${progress}% (${processedTokens}/${this.totalSupply} tokens) | Time elapsed: ${elapsedMinutes} minutes`);
      
      await sleep(RETRY_DELAY);
    }
    
    // Recheck tokens with retry logic
    if (tokensToRecheck.size > 0) {
      for (let pass = 1; pass <= 3; pass++) {
        if (tokensToRecheck.size === 0) break;
        
        console.log(`\nPass ${pass}: Rechecking ${tokensToRecheck.size} tokens...`);
        const tokensArray = Array.from(tokensToRecheck);
        
        const recheckBatches = [];
        const batchSize = Math.max(5, Math.floor(this.batchSize / pass));
        for (let i = 0; i < tokensArray.length; i += batchSize) {
          recheckBatches.push(tokensArray.slice(i, i + batchSize));
        }
        
        for (const batch of recheckBatches) {
          await sleep(RETRY_DELAY * pass);
          
          let results = null;
          let attempts = pass;
          
          while (attempts > 0) {
            try {
              results = await this.getTokenOwnerBatch(snapshotBlock, batch);
              break;
            } catch (err) {
              attempts--;
              if (attempts > 0) {
                await sleep(1000 * (pass - attempts));
              }
            }
          }
          
          if (!results) continue;
          
          for (const result of results) {
            if (!tokensToRecheck.has(result.tokenId)) continue;
            
            if (result.owner && result.owner !== ethers.ZeroAddress) {
              console.log(`✅ Found Token ${result.tokenId} in pass ${pass} | Owner: ${result.owner}`);
              finalSnapshot[result.tokenId] = {
                owner: result.owner,
                block: snapshotBlock
              };
              totalFound++;
              tokensToRecheck.delete(result.tokenId);
            }
          }
        }
      }
    }
    
    return await this.generateOutput(finalSnapshot, totalFound, startTime);
  }

  async generateOutput(finalSnapshot, totalFound, startTime) {
    // Clean up old snapshot files
    const files = fs.readdirSync('.');
    const oldSnapshots = files.filter(file => file.startsWith('Infinity Holders') && file.endsWith('.csv'));
    oldSnapshots.forEach(file => {
      fs.unlinkSync(file);
      console.log(`Removing old snapshot: ${file}`);
    });

    // Generate CSV output with current date
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const csvFileName = `Infinity Holders ${month}.${day}.csv`;
    
    // Create CSV data
    const csvData = [];
    Object.entries(finalSnapshot).forEach(([tokenId, tokenData]) => {
      csvData.push({
        TokenId: tokenId,
        Owner: tokenData.owner,
        Chain: 'ethereum',
        BlockNumber: tokenData.block
      });
    });
    
    csvData.sort((a, b) => parseInt(a.TokenId) - parseInt(b.TokenId));
    
    const csvWriter = createCsvWriter({
      path: csvFileName,
      header: [
        {id: 'TokenId', title: 'TokenId'},
        {id: 'Owner', title: 'Owner'},
        {id: 'Chain', title: 'Chain'},
        {id: 'BlockNumber', title: 'BlockNumber'}
      ]
    });
    
    await csvWriter.writeRecords(csvData);

    const endTime = Date.now();
    const totalRuntime = ((endTime - startTime) / 1000 / 60).toFixed(2);

    console.log("\n=== Infinity Snapshot Summary ===");
    console.log(`- Total Supply: ${this.totalSupply}`);
    console.log(`- Tokens Found: ${totalFound}`);
    console.log(`- Tokens Not Found: ${this.totalSupply - totalFound}`);
    console.log(`- Success Rate: ${((totalFound / this.totalSupply) * 100).toFixed(2)}%`);
    console.log(`- Total Runtime: ${totalRuntime} minutes`);
    console.log(`\nCompleted! Results saved to ${csvFileName}`);
    
    return {
      foundTokens: finalSnapshot,
      outputFile: csvFileName,
      stats: {
        total: this.totalSupply,
        found: totalFound,
        missing: this.totalSupply - totalFound,
        successRate: ((totalFound / this.totalSupply) * 100).toFixed(2),
        runtime: totalRuntime
      }
    };
  }
}

/**
 * PANDA MULTI-CHAIN SNAPSHOTTER CLASS
 */
class PandaSnapshotter {
  constructor() {
    this.contractAddress = CONTRACTS.panda.address;
    this.totalSupply = CONTRACTS.panda.totalSupply;
    this.batchSize = BATCH_SIZE;
  }

  async getLatestBlocks() {
    for (const [chainName, config] of Object.entries(chains)) {
      if (!config.rpc) {
        console.warn(`No RPC URL for ${chainName}, skipping...`);
        continue;
      }
      
      console.log(`Fetching latest block for ${chainName}...`);
      const provider = getProvider(chainName, config);
      const blockNumber = await provider.getBlockNumber();
      config.snapshotBlock = blockNumber;
      console.log(`Chain: ${chainName} | Latest block: ${blockNumber}`);
      await sleep(RETRY_DELAY);
    }
  }

  async getTokenOwnerBatch(chainName, chainConfig, tokenIds) {
    const provider = getProvider(chainName, chainConfig);
    const contract = new ethers.Contract(this.contractAddress, abi, provider);
    
    return await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const owner = await contract.ownerOf(tokenId, { blockTag: chainConfig.snapshotBlock });
          return { tokenId, owner };
        } catch (err) {
          return { tokenId, owner: null };
        }
      })
    );
  }

  generateWalletSummary(foundTokens) {
    const walletCounts = {};
    Object.values(foundTokens).forEach(({ owner }) => {
      walletCounts[owner] = (walletCounts[owner] || 0) + 1;
    });
    return walletCounts;
  }

  async snapshotNFTs() {
    const finalSnapshot = {};
    const startTime = Date.now();
    const tokensToRecheck = new Set();
    const chainStats = {};
    
    Object.keys(chains).forEach(chain => {
      chainStats[chain] = 0;
    });

    console.log(`Starting to process ${this.totalSupply} Panda tokens across ${Object.keys(chains).length} chains...`);
    
    // Create batches
    const batches = [];
    for (let i = 1; i <= this.totalSupply; i += this.batchSize) {
      const batch = [];
      for (let j = 0; j < this.batchSize && i + j <= this.totalSupply; j++) {
        batch.push(i + j);
      }
      batches.push(batch);
    }
    
    // Process each batch
    for (const batch of batches) {
      const batchStart = Math.min(...batch);
      const batchEnd = Math.max(...batch);
      console.log(`\nProcessing batch ${batchStart}-${batchEnd}...`);
      
      const chainPromises = Object.entries(chains).map(async ([chainName, chainConfig]) => {
        if (!chainConfig.snapshotBlock || !chainConfig.rpc) return null;
        const results = await this.getTokenOwnerBatch(chainName, chainConfig, batch);
        return { chainName, results };
      });
      
      const chainResults = await Promise.all(chainPromises);
      
      for (const tokenId of batch) {
        let foundOnChain = false;
        
        for (const chainResult of chainResults) {
          if (!chainResult) continue;
          
          const { chainName, results } = chainResult;
          const result = results.find(r => r.tokenId === tokenId);
          
          if (result?.owner && result.owner !== ethers.ZeroAddress) {
            console.log(`✅ Found Token ${tokenId} on ${chainName} | Owner: ${result.owner}`);
            finalSnapshot[tokenId] = {
              owner: result.owner,
              chain: chainName,
              block: chains[chainName].snapshotBlock,
            };
            chainStats[chainName]++;
            foundOnChain = true;
            break;
          }
        }
        
        if (!foundOnChain) {
          console.log(`❌ Token ${tokenId} not found on any chain`);
          tokensToRecheck.add(tokenId);
        }
      }
      
      const processedTokens = Math.min(batchEnd, this.totalSupply);
      const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
      const progress = ((processedTokens / this.totalSupply) * 100).toFixed(2);
      console.log(`Progress: ${progress}% (${processedTokens}/${this.totalSupply} tokens) | Time elapsed: ${elapsedMinutes} minutes`);
      
      await sleep(50);
    }
    
    // Retry logic for missed tokens
    if (tokensToRecheck.size > 0) {
      for (let pass = 1; pass <= 3; pass++) {
        if (tokensToRecheck.size === 0) break;
        
        console.log(`\nPass ${pass}: Rechecking ${tokensToRecheck.size} tokens...`);
        const tokensArray = Array.from(tokensToRecheck);
        
        const recheckBatches = [];
        const batchSize = Math.max(5, Math.floor(this.batchSize / pass));
        for (let i = 0; i < tokensArray.length; i += batchSize) {
          recheckBatches.push(tokensArray.slice(i, i + batchSize));
        }
        
        for (const batch of recheckBatches) {
          await sleep(50 * pass);
          
          const chainPromises = Object.entries(chains).map(async ([chainName, chainConfig]) => {
            if (!chainConfig.snapshotBlock || !chainConfig.rpc) return null;
            
            let attempts = pass;
            let results = null;
            
            while (attempts > 0) {
              try {
                results = await this.getTokenOwnerBatch(chainName, chainConfig, batch);
                break;
              } catch (err) {
                attempts--;
                if (attempts > 0) {
                  await sleep(1000 * (pass - attempts));
                }
              }
            }
            
            return { chainName, results };
          });
          
          const chainResults = await Promise.all(chainPromises);
          
          for (const tokenId of batch) {
            if (!tokensToRecheck.has(tokenId)) continue;
            
            let found = false;
            for (const chainResult of chainResults) {
              if (!chainResult) continue;
              
              const { chainName, results } = chainResult;
              const result = results?.find(r => r.tokenId === tokenId);
              
              if (result?.owner && result.owner !== ethers.ZeroAddress) {
                console.log(`✅ Found Token ${tokenId} on ${chainName} in pass ${pass} | Owner: ${result.owner}`);
                finalSnapshot[tokenId] = {
                  owner: result.owner,
                  chain: chainName,
                  block: chains[chainName].snapshotBlock,
                };
                chainStats[chainName]++;
                found = true;
                tokensToRecheck.delete(tokenId);
                break;
              }
            }
          }
        }
      }
    }
    
    return await this.generateOutput(finalSnapshot, chainStats, startTime);
  }

  async generateOutput(finalSnapshot, chainStats, startTime) {
    const endTime = Date.now();
    const totalRuntime = ((endTime - startTime) / 1000 / 60).toFixed(2);
    const totalFound = Object.keys(finalSnapshot).length;

    // Clean up old files
    const files = fs.readdirSync('.');
    files.forEach(file => {
      if (file.startsWith('Panda Holders') && file.endsWith('.csv')) {
        console.log(`Removing old snapshot: ${file}`);
        fs.unlinkSync(file);
      }
    });

    // Create CSV data
    const csvData = [];
    Object.entries(finalSnapshot).forEach(([tokenId, tokenData]) => {
      csvData.push({
        TokenId: tokenId,
        Owner: tokenData.owner,
        Chain: tokenData.chain,
        BlockNumber: tokenData.block
      });
    });
    
    csvData.sort((a, b) => parseInt(a.TokenId) - parseInt(b.TokenId));
    
    const walletCounts = this.generateWalletSummary(finalSnapshot);
    const sortedWallets = Object.entries(walletCounts).sort((a, b) => b[1] - a[1]);

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const dateString = `${month}.${day}`;
    const outputFile = `Panda Holders ${dateString}.csv`;
    
    const csvWriter = createCsvWriter({
      path: outputFile,
      header: [
        {id: 'TokenId', title: 'TokenId'},
        {id: 'Owner', title: 'Owner'},
        {id: 'Chain', title: 'Chain'},
        {id: 'BlockNumber', title: 'BlockNumber'}
      ]
    });
    
    await csvWriter.writeRecords(csvData);

    console.log("\n=== Multi-Chain Panda Snapshot Summary ===");
    console.log(`- Total Supply: ${this.totalSupply}`);
    console.log(`- Tokens Found: ${totalFound}`);
    console.log(`- Tokens Not Found: ${this.totalSupply - totalFound}`);
    console.log(`- Success Rate: ${((totalFound / this.totalSupply) * 100).toFixed(2)}%`);
    console.log(`- Total unique wallets: ${sortedWallets.length}`);
    console.log(`- Total Runtime: ${totalRuntime} minutes`);

    console.log("\nChain Distribution:");
    Object.entries(chainStats).forEach(([chain, count]) => {
      if (count > 0) {
        console.log(`- ${chain}: ${count} tokens`);
      }
    });

    console.log("\nTop 5 Holders:");
    sortedWallets.slice(0, 5).forEach(([address, count], index) => {
      console.log(`${index + 1}. ${address}: ${count} tokens`);
    });

    console.log(`\nCompleted! Results saved to ${outputFile}`);
    
    return {
      processedData: csvData,
      outputFile: outputFile,
      stats: {
        total: this.totalSupply,
        found: totalFound,
        missing: this.totalSupply - totalFound,
        successRate: ((totalFound / this.totalSupply) * 100).toFixed(2),
        runtime: totalRuntime,
        uniqueWallets: sortedWallets.length
      }
    };
  }
}

/**
 * SOLANA PANDA SNAPSHOTTER CLASS
 */
class SolanaPandaSnapshotter {
  constructor() {
    this.maxConcurrent = MAX_CONCURRENT;
    this.activeRequests = 0;
    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": "SolanaPandaOwnershipBot/1.0"
    };
    this.heliusRpc = CONTRACTS.solanaPanda.heliusRpc;
  }

  async waitForSlot() {
    while (this.activeRequests >= this.maxConcurrent) {
      await sleep(100);
    }
    this.activeRequests++;
  }

  releaseSlot() {
    this.activeRequests--;
  }

  async getNFTOwner(mintAddress) {
    if (!mintAddress || mintAddress.trim() === '') {
      return null;
    }

    const maxRetries = 5;
    let retryDelay = 2000;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.waitForSlot();
      
      try {
        if (attempt > 0) {
          await sleep(retryDelay * attempt);
        }
        
        const payload = {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [mintAddress, { commitment: "confirmed" }]
        };
        
        const response = await axios.post(this.heliusRpc, payload, {
          headers: this.headers,
          timeout: 60000
        });
        
        if (response.status === 429) {
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
        
        if (!response.data || !response.data.result) {
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 1));
          continue;
        }
        
        const accounts = response.data.result.value;
        const activeAccounts = accounts.filter(acc => parseInt(acc.amount) > 0);
        
        if (activeAccounts.length === 0) {
          this.releaseSlot();
          await sleep(retryDelay);
          continue;
        }
        
        const tokenAccount = activeAccounts[0].address;
        await sleep(200);
        
        const ownerPayload = {
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [tokenAccount, { encoding: "jsonParsed" }]
        };
        
        const ownerResponse = await axios.post(this.heliusRpc, ownerPayload, {
          headers: this.headers,
          timeout: 60000
        });
        
        if (ownerResponse.status === 429) {
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
        
        if (!ownerResponse.data || !ownerResponse.data.result) {
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 1));
          continue;
        }
        
        const accountData = ownerResponse.data.result.value;
        if (accountData && accountData.data && accountData.data.parsed) {
          const owner = accountData.data.parsed.info.owner;
          console.log(`✅ Found owner ${owner} for mint ${mintAddress}`);
          this.releaseSlot();
          return owner;
        }
        
        this.releaseSlot();
        await sleep(retryDelay);
        continue;
        
      } catch (error) {
        this.releaseSlot();
        console.error(`Error processing mint ${mintAddress} (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
        
        if (error.response && error.response.status === 429) {
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
        
        if (attempt < maxRetries - 1) {
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
      }
    }
    
    console.error(`❌ Failed to get owner for mint ${mintAddress} after ${maxRetries} attempts`);
    return null;
  }

  async readCSV(inputFile) {
    return new Promise((resolve, reject) => {
      const results = [];
      
      if (!fs.existsSync(inputFile)) {
        reject(new Error(`Input file not found: ${inputFile}`));
        return;
      }
      
      fs.createReadStream(inputFile)
        .pipe(csv())
        .on('data', (data) => {
          results.push(data);
        })
        .on('end', () => {
          resolve(results);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  async processEarningsCSV(inputFile = CONTRACTS.solanaPanda.inputFile) {
    try {
      console.log(`Reading CSV file: ${inputFile}`);
      const data = await this.readCSV(inputFile);
      
      if (data.length === 0) {
        throw new Error("CSV file is empty");
      }
      
      const requiredColumns = ['SolanaTokenId'];
      const firstRow = data[0];
      const missingColumns = requiredColumns.filter(col => !(col in firstRow));
      
      if (missingColumns.length > 0) {
        throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
      }
      
      const validData = data.filter(row => row.SolanaTokenId && row.SolanaTokenId.trim() !== '');
      
      console.log(`Processing ${validData.length} Solana Panda NFTs with valid token IDs`);
      
      validData.forEach(row => {
        row.OwnerWallet = null;
      });
      
      const startTime = Date.now();
      
      // Process in batches
      for (let startIdx = 0; startIdx < validData.length; startIdx += BATCH_SIZE) {
        const endIdx = Math.min(startIdx + BATCH_SIZE, validData.length);
        const batch = validData.slice(startIdx, endIdx);
        
        console.log(`\nProcessing batch ${startIdx + 1}-${endIdx}...`);
        
        const batchPromises = batch.map(async (row, batchIdx) => {
          if (!row.SolanaTokenId) {
            return;
          }
          
          const owner = await this.getNFTOwner(row.SolanaTokenId);
          row.OwnerWallet = owner;
          
          if (owner) {
            console.log(`✅ Found owner ${owner} for mint ${row.SolanaTokenId}`);
          } else {
            console.warn(`❌ Could not find owner for token ${row.SolanaTokenId}`);
          }
        });
        
        await Promise.all(batchPromises);
        
        console.log(`Processed ${endIdx}/${validData.length} NFTs`);
        await sleep(200);
      }
      
      return await this.generateOutput(validData, startTime);
      
    } catch (error) {
      console.error(`Error processing CSV: ${error.message}`);
      throw error;
    }
  }

  async generateOutput(validData, startTime) {
    // Clean up old files
    const files = fs.readdirSync('.');
    files.forEach(file => {
      if (file.startsWith('Solana Panda Holders') && file.endsWith('.csv')) {
        console.log(`Removing old snapshot: ${file}`);
        fs.unlinkSync(file);
      }
    });
    
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const dateString = `${month}.${day}`;
    const outputFile = `Solana Panda Holders ${dateString}.csv`;
    
    const headers = Object.keys(validData[0]).map(key => ({
      id: key,
      title: key
    }));
    
    const csvWriter = createCsvWriter({
      path: outputFile,
      header: headers
    });
    
    await csvWriter.writeRecords(validData);
    
    const endTime = Date.now();
    const totalRuntime = ((endTime - startTime) / 1000 / 60).toFixed(2);
    
    const foundOwners = validData.filter(row => row.OwnerWallet).length;
    const missingOwners = validData.length - foundOwners;
    
    console.log("\n=== Solana Panda Snapshot Summary ===");
    console.log(`- Total NFTs Processed: ${validData.length}`);
    console.log(`- Owners Found: ${foundOwners}`);
    console.log(`- Owners Not Found: ${missingOwners}`);
    console.log(`- Success Rate: ${((foundOwners / validData.length) * 100).toFixed(2)}%`);
    console.log(`- Total Runtime: ${totalRuntime} minutes`);
    console.log(`\nCompleted! Results saved to ${outputFile}`);
    
    return {
      processedData: validData,
      outputFile: outputFile,
      stats: {
        total: validData.length,
        found: foundOwners,
        missing: missingOwners,
        successRate: ((foundOwners / validData.length) * 100).toFixed(2),
        runtime: totalRuntime
      }
    };
  }
}

/**
 * UNIFIED INTERFACE AND MENU SYSTEM
 */
class KanpaiSnapshotter {
  constructor() {
    this.infinitySnapshotter = new InfinitySnapshotter();
    this.pandaSnapshotter = new PandaSnapshotter();
    this.solanaPandaSnapshotter = new SolanaPandaSnapshotter();
  }

  async displayMenu() {
    console.log("\n" + "=".repeat(60));
    console.log("🐼 KANPAI PANDA UNIFIED SNAPSHOTTER 🐼");
    console.log("=".repeat(60));
    console.log("Select a snapshotter to run:");
    console.log("");
    console.log("1. Infinity NFT Snapshotter (Ethereum Only)");
    console.log("   - 250 NFTs on Ethereum");
    console.log("   - Contract: 0x7Db7A0f8971C5d57F1ee44657B447D5D053B6bAE");
    console.log("");
    console.log("2. Panda Multi-Chain Snapshotter");
    console.log("   - 9,000 NFTs across 7 chains");
    console.log("   - Ethereum, Arbitrum, Optimism, BSC, Polygon, Fantom, Avalanche");
    console.log("   - Contract: 0xaCF63E56fd08970b43401492a02F6F38B6635C91");
    console.log("");
    console.log("3. Solana Panda Snapshotter");
    console.log("   - Reads from Solana Panda Earnings.csv");
    console.log("   - Uses Helius API for Solana blockchain");
    console.log("");
    console.log("4. Run All Snapshotters (Sequential)");
    console.log("");
    console.log("5. Exit");
    console.log("=".repeat(60));
  }

  async runInfinitySnapshotter() {
    try {
      console.log("\n🚀 Starting Infinity NFT Snapshotter...");
      
      if (!chains.ethereum.rpc) {
        throw new Error("ETH_RPC_URL is required for Infinity snapshotter");
      }
      
      const provider = getProvider("ethereum", chains.ethereum);
      const snapshotBlock = await provider.getBlockNumber();
      console.log(`Using latest Ethereum block number ${snapshotBlock} for snapshot`);
      
      return await this.infinitySnapshotter.snapshotNFTs(snapshotBlock);
    } catch (error) {
      console.error("Error in Infinity snapshotter:", error.message);
      throw error;
    }
  }

  async runPandaSnapshotter() {
    try {
      console.log("\n🚀 Starting Panda Multi-Chain Snapshotter...");
      
      const missingRpcs = Object.entries(chains)
        .filter(([name, config]) => !config.rpc)
        .map(([name]) => name);
      
      if (missingRpcs.length > 0) {
        console.warn(`Warning: Missing RPC URLs for chains: ${missingRpcs.join(', ')}`);
        console.log("These chains will be skipped during the snapshot process.");
      }
      
      await this.pandaSnapshotter.getLatestBlocks();
      return await this.pandaSnapshotter.snapshotNFTs();
    } catch (error) {
      console.error("Error in Panda snapshotter:", error.message);
      throw error;
    }
  }

  async runSolanaSnapshotter() {
    try {
      console.log("\n🚀 Starting Solana Panda Snapshotter...");
      
      if (!HELIUS_API_KEY) {
        throw new Error("HELIUS_API_KEY is required for Solana snapshotter");
      }
      
      if (!fs.existsSync(CONTRACTS.solanaPanda.inputFile)) {
        throw new Error(`Input file not found: ${CONTRACTS.solanaPanda.inputFile}`);
      }
      
      return await this.solanaPandaSnapshotter.processEarningsCSV();
    } catch (error) {
      console.error("Error in Solana snapshotter:", error.message);
      throw error;
    }
  }

  async runAllSnapshotters() {
    console.log("\n🚀 Running All Snapshotters Sequentially...");
    const results = {};
    
    try {
      console.log("\n" + "=".repeat(40));
      console.log("STEP 1/3: Infinity NFT Snapshotter");
      console.log("=".repeat(40));
      results.infinity = await this.runInfinitySnapshotter();
    } catch (error) {
      console.error("Infinity snapshotter failed:", error.message);
      results.infinity = { error: error.message };
    }
    
    try {
      console.log("\n" + "=".repeat(40));
      console.log("STEP 2/3: Panda Multi-Chain Snapshotter");
      console.log("=".repeat(40));
      results.panda = await this.runPandaSnapshotter();
    } catch (error) {
      console.error("Panda snapshotter failed:", error.message);
      results.panda = { error: error.message };
    }
    
    try {
      console.log("\n" + "=".repeat(40));
      console.log("STEP 3/3: Solana Panda Snapshotter");
      console.log("=".repeat(40));
      results.solana = await this.runSolanaSnapshotter();
    } catch (error) {
      console.error("Solana snapshotter failed:", error.message);
      results.solana = { error: error.message };
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("🎉 ALL SNAPSHOTTERS COMPLETED");
    console.log("=".repeat(60));
    
    Object.entries(results).forEach(([name, result]) => {
      if (result.error) {
        console.log(`❌ ${name.toUpperCase()}: FAILED - ${result.error}`);
      } else {
        console.log(`✅ ${name.toUpperCase()}: SUCCESS - ${result.outputFile}`);
        if (result.stats) {
          console.log(`   - Found: ${result.stats.found}/${result.stats.total} (${result.stats.successRate}%)`);
          console.log(`   - Runtime: ${result.stats.runtime} minutes`);
        }
      }
    });
    
    return results;
  }

  async start() {
    try {
      validateEnvironment();
      
      while (true) {
        await this.displayMenu();
        const choice = await question("\nEnter your choice (1-5): ");
        
        switch (choice.trim()) {
          case '1':
            await this.runInfinitySnapshotter();
            break;
          case '2':
            await this.runPandaSnapshotter();
            break;
          case '3':
            await this.runSolanaSnapshotter();
            break;
          case '4':
            await this.runAllSnapshotters();
            break;
          case '5':
            console.log("\n👋 Goodbye!");
            rl.close();
            return;
          default:
            console.log("\n❌ Invalid choice. Please enter 1-5.");
            continue;
        }
        
        const continueChoice = await question("\nWould you like to run another snapshotter? (y/n): ");
        if (continueChoice.toLowerCase() !== 'y') {
          console.log("\n👋 Goodbye!");
          rl.close();
          return;
        }
      }
    } catch (error) {
      console.error("\n💥 Fatal error:", error.message);
      rl.close();
      process.exit(1);
    }
  }
}

/**
 * MAIN EXECUTION
 */
async function main() {
  const kanpaiSnapshotter = new KanpaiSnapshotter();
  await kanpaiSnapshotter.start();
}

// Export classes and functions for potential module use
module.exports = {
  KanpaiSnapshotter,
  InfinitySnapshotter,
  PandaSnapshotter,
  SolanaPandaSnapshotter,
  main
};

// Auto-execute if this is the main module
if (require.main === module) {
  main();
} 