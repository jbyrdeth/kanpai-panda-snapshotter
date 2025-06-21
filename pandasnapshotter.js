const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
require('dotenv').config();
// readline and promisify removed - no longer needed

// Utility function for rate limiting and delays
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Environment validation and configuration
if (!process.env.MORALIS_API_KEY) {
  throw new Error("MORALIS_API_KEY is required in .env file");
}

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "200");
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xaCF63E56fd08970b43401492a02F6F38B6635C91";
const TOTAL_SUPPLY = parseInt(process.env.TOTAL_SUPPLY || "9000");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "25");

// Chain configurations
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

// Validate RPC URLs
Object.entries(chains).forEach(([chain, config]) => {
  if (!config.rpc) {
    throw new Error(`RPC URL for ${chain} is required in .env file (${chain.toUpperCase()}_RPC_URL)`);
  }
});

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

function calculateBatchSize(remainingTokens, errorRate = 0) {
  if (errorRate > 0.5) return 10;
  if (errorRate > 0.2) return 15;
  if (remainingTokens < 100) return 10;
  return 25;
}

async function processTokenBatch(chainName, chainConfig, tokenIds, attempt = 1) {
  const provider = getProvider(chainName, chainConfig);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  
  const results = await Promise.all(
    tokenIds.map(async (tokenId) => {
      try {
        const owner = await contract.ownerOf(tokenId, { blockTag: chainConfig.snapshotBlock });
        return { tokenId, owner, success: true };
      } catch (err) {
        return { tokenId, owner: null, success: false, error: err.message };
      }
    })
  );
  
  return { results, errorRate: results.filter(r => !r.success).length / results.length };
}

/**
 * Get the block number for a given chain and Unix timestamp using Moralis API.
 * @param {string} moralisChain - Chain parameter for Moralis (e.g. "eth", "polygon")
 * @param {number|string} timestamp - Unix timestamp (in seconds) or a date string
 * @returns {Promise<number>} Block number closest to the given timestamp
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

async function populateSnapshotBlocks(unixTimestamp) {
  for (const [chainName, config] of Object.entries(chains)) {
    const moralisChain = moralisChains[chainName];
    if (!moralisChain) {
      console.warn(`No Moralis chain mapping for ${chainName}. Skipping.`);
      continue;
    }
    
    console.log(`Fetching snapshot block for ${chainName} at timestamp ${unixTimestamp}...`);
    const blockNumber = await getBlockForTimestamp(moralisChain, unixTimestamp);
    config.snapshotBlock = blockNumber;
    console.log(`Chain: ${chainName} | Snapshot block: ${blockNumber}`);
    await sleep(RETRY_DELAY);
  }
}

async function getTokenOwnerBatch(chainName, chainConfig, tokenIds) {
  const provider = getProvider(chainName, chainConfig);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  
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

/**
 * Processes the found tokens data to create a simple wallet holdings summary
 * @param {Object} foundTokens - The object containing found token data
 * @returns {Object} Map of wallet addresses to total token counts
 */
function generateWalletSummary(foundTokens) {
    const walletCounts = {};

    // Count tokens per wallet
    Object.values(foundTokens).forEach(({ owner }) => {
        walletCounts[owner] = (walletCounts[owner] || 0) + 1;
    });

    return walletCounts;
}

async function snapshotNFTs() {
  const finalSnapshot = {};
  const startTime = Date.now();
  const tokensToRecheck = new Set();
  const chainStats = {};
  
  Object.keys(chains).forEach(chain => {
    chainStats[chain] = 0;
  });

  console.log(`Starting to process ${TOTAL_SUPPLY} tokens across ${Object.keys(chains).length} chains...`);
  
  // Create batches of token IDs
  const batches = [];
  for (let i = 1; i <= TOTAL_SUPPLY; i += BATCH_SIZE) {
    const batch = [];
    for (let j = 0; j < BATCH_SIZE && i + j <= TOTAL_SUPPLY; j++) {
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
      if (!chainConfig.snapshotBlock) return null;
      const results = await getTokenOwnerBatch(chainName, chainConfig, batch);
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
    
    const processedTokens = Math.min(batchEnd, TOTAL_SUPPLY);
    const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const progress = ((processedTokens / TOTAL_SUPPLY) * 100).toFixed(2);
    console.log(`Progress: ${progress}% (${processedTokens}/${TOTAL_SUPPLY} tokens) | Time elapsed: ${elapsedMinutes} minutes`);
    
    await sleep(50);
  }
  
  // Recheck tokens that weren't found with three increasingly thorough passes
  if (tokensToRecheck.size > 0) {
    for (let pass = 1; pass <= 3; pass++) {
      if (tokensToRecheck.size === 0) break;
      
      console.log(`\nPass ${pass}: Rechecking ${tokensToRecheck.size} tokens...`);
      const tokensArray = Array.from(tokensToRecheck);
      
      // Create batches for this pass
      const recheckBatches = [];
      const batchSize = Math.max(5, Math.floor(BATCH_SIZE / pass)); // Decrease batch size with each pass
      for (let i = 0; i < tokensArray.length; i += batchSize) {
        recheckBatches.push(tokensArray.slice(i, i + batchSize));
      }
      
      // Process recheck batches
      for (const batch of recheckBatches) {
        const batchStart = Math.min(...batch);
        const batchEnd = Math.max(...batch);
        console.log(`\nPass ${pass}: Processing batch ${batchStart}-${batchEnd}...`);
        
        // Add delay between batches that increases with each pass
        await sleep(50 * pass);
        
        const chainPromises = Object.entries(chains).map(async ([chainName, chainConfig]) => {
          if (!chainConfig.snapshotBlock) return null;
          
          // Add retries for later passes
          let attempts = pass;
          let results = null;
          
          while (attempts > 0) {
            try {
              results = await getTokenOwnerBatch(chainName, chainConfig, batch);
              break;
            } catch (err) {
              attempts--;
              if (attempts > 0) {
                await sleep(1000 * (pass - attempts)); // Exponential backoff
              }
            }
          }
          
          return { chainName, results };
        });
        
        const chainResults = await Promise.all(chainPromises);
        
        for (const tokenId of batch) {
          if (!tokensToRecheck.has(tokenId)) continue; // Skip if found in a parallel promise
          
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
          
          if (!found && pass === 3) {
            console.log(`❌ Token ${tokenId} not found after all passes`);
          }
        }
      }
      
      console.log(`\nPass ${pass} complete. ${tokensToRecheck.size} tokens remaining.`);
    }
  }
  
  // Generate snapshot files
  const timestamp = Math.floor(Date.now() / 1000);
  const endTime = Date.now();
  const totalRuntime = ((endTime - startTime) / 1000 / 60).toFixed(2);
  const totalFound = Object.keys(finalSnapshot).length;

  // Clean up old snapshot files first
  const files = fs.readdirSync('.');
  files.forEach(file => {
    if (file.startsWith('Panda Holders') && file.endsWith('.csv')) {
      console.log(`Removing old snapshot: ${file}`);
      fs.unlinkSync(file);
    }
  });

  // Create CSV data with only found tokens
  const csvData = [];
  
  // Add only found tokens to CSV data
  Object.entries(finalSnapshot).forEach(([tokenId, tokenData]) => {
    csvData.push({
      TokenId: tokenId,
      Owner: tokenData.owner,
      Chain: tokenData.chain,
      BlockNumber: tokenData.block
    });
  });
  
  // Sort by token ID
  csvData.sort((a, b) => parseInt(a.TokenId) - parseInt(b.TokenId));
  
  // Generate wallet summary for display
  const walletCounts = generateWalletSummary(finalSnapshot);
  const sortedWallets = Object.entries(walletCounts)
      .sort((a, b) => b[1] - a[1]);

  // Save CSV file with date-based naming like Solana version
  const now = new Date();
  const month = now.getMonth() + 1; // getMonth() returns 0-11
  const day = now.getDate();
  const dateString = `${month}.${day}`;
  const outputFile = `Panda Holders ${dateString}.csv`;
  
  // Create CSV content
  const csvHeaders = ['TokenId', 'Owner', 'Chain', 'BlockNumber', 'Status'];
  const csvContent = [csvHeaders.join(',')];
  
  csvData.forEach(row => {
    const values = [
      row.TokenId,
      row.Owner || '',
      row.Chain || '',
      row.BlockNumber || '',
      row.Status
    ];
    csvContent.push(values.join(','));
  });
  
  fs.writeFileSync(outputFile, csvContent.join('\n'));

  // Display summary statistics
  console.log("\n=== Multi-Chain Snapshot Summary ===");
  console.log(`\nProcessing Statistics:`);
  console.log(`- Total Supply: ${TOTAL_SUPPLY}`);
  console.log(`- Tokens Found: ${totalFound}`);
  console.log(`- Tokens Not Found: ${TOTAL_SUPPLY - totalFound}`);
  console.log(`- Success Rate: ${((totalFound / TOTAL_SUPPLY) * 100).toFixed(2)}%`);
  console.log(`- Total unique wallets: ${sortedWallets.length}`);
  console.log(`- Average tokens per wallet: ${(totalFound / sortedWallets.length).toFixed(2)}`);
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
      total: TOTAL_SUPPLY,
      found: totalFound,
      missing: TOTAL_SUPPLY - totalFound,
      successRate: ((totalFound / TOTAL_SUPPLY) * 100).toFixed(2),
      runtime: totalRuntime,
      uniqueWallets: sortedWallets.length
    }
  };
}

/**
 * Gets the latest block number for each chain
 */
async function getLatestBlocks() {
  for (const [chainName, config] of Object.entries(chains)) {
    console.log(`Fetching latest block for ${chainName}...`);
    const provider = getProvider(chainName, config);
    const blockNumber = await provider.getBlockNumber();
    config.snapshotBlock = blockNumber;
    console.log(`Chain: ${chainName} | Latest block: ${blockNumber}`);
    await sleep(RETRY_DELAY);
  }
}

// Readline interface removed - no longer needed since we auto-use latest blocks

// Function to validate date input
function isValidDate(dateString) {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// Function to get user input for date and time
async function getCustomTimestamp() {
  try {
    console.log("\n=== Custom Snapshot Time Setup ===");
    console.log("Please enter the date and time for the snapshot.");
    console.log("Examples:");
    console.log("- Date format: YYYY-MM-DD (e.g., 2024-12-31)");
    console.log("- Time format: HH:mm (24-hour format) (e.g., 23:59)");
    console.log("- Timezone: All times are in UTC\n");

    let dateInput;
    let timeInput;
    
    // Get and validate date
    while (true) {
      dateInput = await question("Enter date (YYYY-MM-DD): ");
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput) && isValidDate(dateInput)) {
        break;
      }
      console.log("❌ Invalid date format. Please use YYYY-MM-DD format.");
    }

    // Get and validate time
    while (true) {
      timeInput = await question("Enter time in UTC (HH:mm): ");
      if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeInput)) {
        break;
      }
      console.log("❌ Invalid time format. Please use HH:mm format (24-hour).");
    }

    // Combine date and time
    const dateTimeString = `${dateInput}T${timeInput}:00Z`;
    const timestamp = Math.floor(new Date(dateTimeString).getTime() / 1000);

    // Show confirmation with converted times
    console.log("\n=== Snapshot Time Confirmation ===");
    console.log(`UTC: ${new Date(timestamp * 1000).toUTCString()}`);
    console.log(`Unix Timestamp: ${timestamp}`);
    
    // Ask for confirmation
    const confirm = await question("\nIs this correct? (y/n): ");
    if (confirm.toLowerCase() !== 'y') {
      console.log("Timestamp setup cancelled. Please try again.");
      return await getCustomTimestamp();
    }

    return timestamp;
  } catch (error) {
    console.error("Error during timestamp setup:", error);
    throw error;
  }
}

// Simplified main function - automatically uses latest blocks like Solana version
async function main() {
  try {
    console.log("Starting multi-chain NFT holders snapshot process");
    
    console.log("Getting latest blocks for all chains...");
    await getLatestBlocks();

    console.log("\nSnapshot block numbers determined for each chain:");
    Object.entries(chains).forEach(([chain, config]) => {
      console.log(`- ${chain}: Block ${config.snapshotBlock}`);
    });
    
    console.log("\nStarting omnichain NFT holders snapshot at the latest blocks...");
    await snapshotNFTs();
    
  } catch (err) {
    console.error("\nError during snapshot process:");
    console.error("Error message:", err.message);
    console.error("Stack trace:", err.stack);
    process.exit(1);
  }
}

// Export the main function and helper functions
module.exports = {
  snapshotNFTs,
  populateSnapshotBlocks,
  getCustomTimestamp,
  main
};

// Auto-execute if this is the main module
if (require.main === module) {
  main();
}
