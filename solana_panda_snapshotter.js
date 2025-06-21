const fs = require("fs");
const axios = require("axios");
const csv = require("csv-parser");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
require('dotenv').config();

// Environment validation and configuration
if (!process.env.HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY is required in .env file");
}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "30"); // Higher concurrency but not rate-limited
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "50"); // Faster but not too aggressive
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50"); // Larger batches but reasonable

// Utility function for rate limiting and delays
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SolanaPandaOwnershipFetcher {
  constructor() {
    this.maxConcurrent = MAX_CONCURRENT;
    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": "SolanaPandaOwnershipBot/1.0"
    };
    this.activeRequests = 0;
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
      console.warn(`Skipping empty mint address`);
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
        
        // First, get the token accounts for this mint
        const payload = {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [mintAddress, { commitment: "confirmed" }]
        };
        
        const response = await axios.post(HELIUS_RPC, payload, {
          headers: this.headers,
          timeout: 60000
        });
        
        if (response.status === 429) {
          console.warn(`Rate limited, waiting ${retryDelay * (attempt + 2)}ms before retry...`);
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
        
        if (!response.data || !response.data.result) {
          console.warn(`No result for mint ${mintAddress}, attempt ${attempt + 1}/${maxRetries}`);
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 1));
          continue;
        }
        
        const accounts = response.data.result.value;
        const activeAccounts = accounts.filter(acc => parseInt(acc.amount) > 0);
        
        if (activeAccounts.length === 0) {
          console.warn(`No active accounts for mint ${mintAddress}`);
          this.releaseSlot();
          await sleep(retryDelay);
          continue;
        }
        
        const tokenAccount = activeAccounts[0].address;
        
        // Balanced delay to avoid rate limits
        await sleep(200);
        
        // Get the owner of the token account
        const ownerPayload = {
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [tokenAccount, { encoding: "jsonParsed" }]
        };
        
        const ownerResponse = await axios.post(HELIUS_RPC, ownerPayload, {
          headers: this.headers,
          timeout: 60000
        });
        
        if (ownerResponse.status === 429) {
          console.warn(`Rate limited on owner lookup, waiting ${retryDelay * (attempt + 2)}ms before retry...`);
          this.releaseSlot();
          await sleep(retryDelay * (attempt + 2));
          continue;
        }
        
        if (!ownerResponse.data || !ownerResponse.data.result) {
          console.warn(`No owner result for token account ${tokenAccount}, attempt ${attempt + 1}/${maxRetries}`);
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
        
        console.warn(`Unexpected data format for token account ${tokenAccount}, attempt ${attempt + 1}/${maxRetries}`);
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

  // Ultra-fast batch processing using getMultipleAccounts
  async processBatchUltraFast(batch) {
    // Step 1: Get all token accounts for all mints in one batch call
    const mintAddresses = batch.map(row => row.SolanaTokenId).filter(mint => mint && mint.trim() !== '');
    
    if (mintAddresses.length === 0) return;
    
    console.log(`Getting token accounts for ${mintAddresses.length} mints...`);
    
    // Get token largest accounts for all mints in parallel (much faster)
    const tokenAccountPromises = mintAddresses.map(async (mint) => {
      try {
        const payload = {
          jsonrpc: "2.0",
          id: mint,
          method: "getTokenLargestAccounts",
          params: [mint, { commitment: "confirmed" }]
        };
        
        const response = await axios.post(HELIUS_RPC, payload, {
          headers: this.headers,
          timeout: 30000
        });
        
        const accounts = response.data?.result?.value || [];
        const activeAccount = accounts.find(acc => parseInt(acc.amount) > 0);
        
        return {
          mint,
          tokenAccount: activeAccount?.address || null
        };
        
      } catch (error) {
        console.warn(`Failed to get token account for ${mint}: ${error.message}`);
        return { mint, tokenAccount: null };
      }
    });
    
    // Execute all token account requests in parallel with high concurrency
    const tokenAccounts = await Promise.all(tokenAccountPromises);
    const validTokenAccounts = tokenAccounts.filter(ta => ta.tokenAccount);
    
    console.log(`Found ${validTokenAccounts.length} valid token accounts`);
    
    // Step 2: Get all account info in batch using getMultipleAccounts (MUCH faster)
    if (validTokenAccounts.length > 0) {
      const accountAddresses = validTokenAccounts.map(ta => ta.tokenAccount);
      
      // Split into chunks of 100 (max for getMultipleAccounts)
      const chunkSize = 100;
      const ownerResults = [];
      
      for (let i = 0; i < accountAddresses.length; i += chunkSize) {
        const chunk = accountAddresses.slice(i, i + chunkSize);
        const chunkTokenAccounts = validTokenAccounts.slice(i, i + chunkSize);
        
        try {
          const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getMultipleAccounts",
            params: [chunk, { encoding: "jsonParsed" }]
          };
          
          const response = await axios.post(HELIUS_RPC, payload, {
            headers: this.headers,
            timeout: 30000
          });
          
          const accounts = response.data?.result?.value || [];
          
          accounts.forEach((account, idx) => {
            const mint = chunkTokenAccounts[idx]?.mint;
            if (account && account.data?.parsed?.info?.owner && mint) {
              const owner = account.data.parsed.info.owner;
              ownerResults.push({ mint, owner });
              console.log(`✅ Found owner ${owner} for mint ${mint}`);
            } else if (mint) {
              console.warn(`❌ Could not find owner for token ${mint}`);
              ownerResults.push({ mint, owner: null });
            }
          });
          
        } catch (error) {
          console.error(`Failed to get multiple accounts: ${error.message}`);
          // Fallback to individual processing for this chunk
          for (const ta of chunkTokenAccounts) {
            ownerResults.push({ mint: ta.mint, owner: null });
          }
        }
        
        // Small delay between chunks
        if (i + chunkSize < accountAddresses.length) {
          await sleep(50);
        }
      }
      
      // Step 3: Map results back to original batch
      batch.forEach(row => {
        if (row.SolanaTokenId) {
          const result = ownerResults.find(r => r.mint === row.SolanaTokenId);
          row.OwnerWallet = result?.owner || null;
        }
      });
    }
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

  async processEarningsCSV(inputFile = "Solana Panda Earnings.csv") {
    try {
      console.log(`Reading CSV file: ${inputFile}`);
      const data = await this.readCSV(inputFile);
      
      // Validate required columns exist
      if (data.length === 0) {
        throw new Error("CSV file is empty");
      }
      
      const requiredColumns = ['SolanaTokenId'];
      const firstRow = data[0];
      const missingColumns = requiredColumns.filter(col => !(col in firstRow));
      
      if (missingColumns.length > 0) {
        throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
      }
      
      // Filter out rows with empty token IDs and log them
      const emptyTokenRows = data.filter(row => !row.SolanaTokenId || row.SolanaTokenId.trim() === '');
      if (emptyTokenRows.length > 0) {
        console.warn(`Skipping ${emptyTokenRows.length} rows with missing token IDs:`);
        emptyTokenRows.forEach((row, idx) => {
          console.warn(`Row with IntTokenId=${row.IntTokenId || 'N/A'}`);
        });
      }
      
      // Filter out rows with empty token IDs
      const validData = data.filter(row => row.SolanaTokenId && row.SolanaTokenId.trim() !== '');
      
      console.log(`Processing ${validData.length} Panda NFTs with valid token IDs`);
      
      // Add owner column to each row
      validData.forEach(row => {
        row.OwnerWallet = null;
      });
      
      const startTime = Date.now();
      
      // Process in batches
      for (let startIdx = 0; startIdx < validData.length; startIdx += BATCH_SIZE) {
        const endIdx = Math.min(startIdx + BATCH_SIZE, validData.length);
        const batch = validData.slice(startIdx, endIdx);
        
        console.log(`\nProcessing batch ${startIdx + 1}-${endIdx}...`);
        
        // Process batch with optimized concurrency (avoiding rate limits)
        const batchPromises = batch.map(async (row, batchIdx) => {
          if (!row.SolanaTokenId) {
            console.warn(`Skipping row due to missing token ID`);
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
        
        // Balanced delay to avoid rate limits while maintaining speed
        await sleep(200);
      }
      
      // Clean up old snapshot files first
      const files = fs.readdirSync('.');
      files.forEach(file => {
        if (file.startsWith('Solana Panda Holders') && file.endsWith('.csv')) {
          console.log(`Removing old snapshot: ${file}`);
          fs.unlinkSync(file);
        }
      });
      
      // Save final result with new naming convention
      const now = new Date();
      const month = now.getMonth() + 1; // getMonth() returns 0-11
      const day = now.getDate();
      const dateString = `${month}.${day}`;
      const outputFile = `Solana Panda Holders ${dateString}.csv`;
      await this.saveCSV(validData, outputFile);
      
      const endTime = Date.now();
      const totalRuntime = ((endTime - startTime) / 1000 / 60).toFixed(2);
      
      // Display statistics
      const foundOwners = validData.filter(row => row.OwnerWallet).length;
      const missingOwners = validData.length - foundOwners;
      
      console.log("\n=== Solana Snapshot Summary ===");
      console.log(`\nProcessing Statistics:`);
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
      
    } catch (error) {
      console.error(`Error processing CSV: ${error.message}`);
      throw error;
    }
  }

  async saveCSV(data, filename) {
    if (data.length === 0) return;
    
    const headers = Object.keys(data[0]).map(key => ({
      id: key,
      title: key
    }));
    
    const csvWriter = createCsvWriter({
      path: filename,
      header: headers
    });
    
    await csvWriter.writeRecords(data);
  }
}

async function main() {
  console.log("Starting Solana Panda NFT ownership fetch process");
  
  const fetcher = new SolanaPandaOwnershipFetcher();
  
  try {
    await fetcher.processEarningsCSV("Solana Panda Earnings.csv");
  } catch (error) {
    console.error(`Error processing CSV: ${error.message}`);
    process.exit(1);
  }
  
  console.log("Process completed successfully");
}

// Export the class and main function
module.exports = {
  SolanaPandaOwnershipFetcher,
  main
};

// Auto-execute if this is the main module
if (require.main === module) {
  main();
} 