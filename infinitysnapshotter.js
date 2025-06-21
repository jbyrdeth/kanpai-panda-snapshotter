const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
require('dotenv').config();

// Environment validation and configuration
if (!process.env.MORALIS_API_KEY) {
  throw new Error("MORALIS_API_KEY is required in .env file");
}

if (!process.env.ETH_RPC_URL) {
  throw new Error("ETH_RPC_URL is required in .env file");
}

// Configuration constants
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "200");
const CONTRACT_ADDRESS = "0x7Db7A0f8971C5d57F1ee44657B447D5D053B6bAE";
const TOTAL_SUPPLY = 250;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "25");

// Minimal ERC-721 ABI
const abi = ["function ownerOf(uint256 tokenId) view returns (address)"];

// Provider setup
let provider;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL, {
      chainId: 1,
      name: "ethereum"
    });
  }
  return provider;
}

// Utility function for rate limiting and delays
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the block number for a given Unix timestamp using Moralis API.
 * @param {number|string} timestamp - Unix timestamp (in seconds) or a date string
 * @returns {Promise<number>} Block number closest to the given timestamp
 */
async function getBlockForTimestamp(timestamp) {
  const url = `https://deep-index.moralis.io/api/v2.2/dateToBlock?chain=eth&date=${timestamp}`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        "X-API-Key": MORALIS_API_KEY,
        Accept: "application/json",
      },
    });
    return response.data.block;
  } catch (err) {
    console.error("Error fetching block:", err.response?.data || err.message);
    throw err;
  }
}

async function getTokenOwnerBatch(snapshotBlock, tokenIds) {
  const provider = getProvider();
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  
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

async function snapshotNFTs(snapshotBlock) {
  const finalSnapshot = {};
  const startTime = Date.now();
  const tokensToRecheck = new Set();
  let totalFound = 0;

  console.log(`Starting to process ${TOTAL_SUPPLY} tokens at block ${snapshotBlock}...`);
  
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
    
    const results = await getTokenOwnerBatch(snapshotBlock, batch);
    
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
    
    const processedTokens = Math.min(batchEnd, TOTAL_SUPPLY);
    const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const progress = ((processedTokens / TOTAL_SUPPLY) * 100).toFixed(2);
    console.log(`Progress: ${progress}% (${processedTokens}/${TOTAL_SUPPLY} tokens) | Time elapsed: ${elapsedMinutes} minutes`);
    
    await sleep(RETRY_DELAY);
  }
  
  // Recheck tokens that weren't found with three increasingly thorough passes
  if (tokensToRecheck.size > 0) {
    for (let pass = 1; pass <= 3; pass++) {
      if (tokensToRecheck.size === 0) break;
      
      console.log(`\nPass ${pass}: Rechecking ${tokensToRecheck.size} tokens...`);
      const tokensArray = Array.from(tokensToRecheck);
      
      // Create smaller batches for rechecks
      const recheckBatches = [];
      const batchSize = Math.max(5, Math.floor(BATCH_SIZE / pass));
      for (let i = 0; i < tokensArray.length; i += batchSize) {
        recheckBatches.push(tokensArray.slice(i, i + batchSize));
      }
      
      for (const batch of recheckBatches) {
        const batchStart = Math.min(...batch);
        const batchEnd = Math.max(...batch);
        console.log(`\nPass ${pass}: Processing batch ${batchStart}-${batchEnd}...`);
        
        await sleep(RETRY_DELAY * pass);
        
        let results = null;
        let attempts = pass;
        
        while (attempts > 0) {
          try {
            results = await getTokenOwnerBatch(snapshotBlock, batch);
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
          } else if (pass === 3) {
            console.log(`❌ Token ${result.tokenId} not found after all passes`);
          }
        }
      }
      
      console.log(`\nPass ${pass} complete. ${tokensToRecheck.size} tokens remaining.`);
    }
  }
  
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
  
  // Create CSV data with only found tokens
  const csvData = [];
  
  // Add only found tokens to CSV data
  Object.entries(finalSnapshot).forEach(([tokenId, tokenData]) => {
    csvData.push({
      TokenId: tokenId,
      Owner: tokenData.owner,
      Chain: 'ethereum',
      BlockNumber: tokenData.block
    });
  });
  
  // Sort by token ID
  csvData.sort((a, b) => parseInt(a.TokenId) - parseInt(b.TokenId));
  
  // Write CSV file
  const csvWriter = require('csv-writer').createObjectCsvWriter({
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

  // Display summary statistics
  console.log("\n=== Snapshot Summary ===");
  console.log(`\nToken Statistics:`);
  console.log(`- Total Supply: ${TOTAL_SUPPLY}`);
  console.log(`- Tokens Found: ${totalFound}`);
  console.log(`- Tokens Not Found: ${TOTAL_SUPPLY - totalFound}`);
  console.log(`- Success Rate: ${((totalFound / TOTAL_SUPPLY) * 100).toFixed(2)}%`);
  console.log(`- Total Runtime: ${totalRuntime} minutes`);

  console.log(`\nCompleted! Results saved to ${csvFileName}`);
  
  return {
    foundTokens: finalSnapshot,
    missingTokens: Array.from(tokensToRecheck)
  };
}

/**
 * Main function: Automatically use latest block for snapshot
 */
async function main() {
  try {
    console.log("Starting Infinity NFT holders snapshot process");
    console.log("Getting latest block number...");
    
    const provider = getProvider();
    const snapshotBlock = await provider.getBlockNumber();
    console.log(`Using latest block number ${snapshotBlock} for snapshot`);
    
    console.log("\nStarting Ethereum NFT holders snapshot...");
    await snapshotNFTs(snapshotBlock);
    
  } catch (err) {
    console.error("\nError during snapshot process:");
    console.error("Error message:", err.message);
    console.error("Stack trace:", err.stack);
    process.exit(1);
  }
}

// Run the main function if this file is run directly
if (require.main === module) {
  main();
}

module.exports = {
  snapshotNFTs,
  getBlockForTimestamp,
}; 