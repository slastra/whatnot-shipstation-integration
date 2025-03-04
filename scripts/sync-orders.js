import WhatnotService from '../services/whatnot.js';
import ShipStationService from '../services/shipstation.js';
import OrderValidator from '../utils/validation.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load account configuration from accounts.json
 */
async function loadAccounts() {
  try {
    const accountsPath = join(__dirname, '../accounts.json');
    const data = await readFile(accountsPath, 'utf-8');
    return JSON.parse(data).accounts;
  } catch (error) {
    console.error('Error loading accounts:', error);
    throw error;
  }
}

/**
 * Process orders for a single account
 * @param {Object} account - Account configuration
 * @returns {Promise<Object>} Results of order processing
 */
async function processAccount(account) {
  console.log(`\n=== Processing account: ${account.name} ===`);
  
  if (!account.enabled) {
    console.log('Account is disabled, skipping');
    return { processed: 0, created: 0, invalid: 0, errors: [] };
  }
  
  try {
    // Initialize Whatnot service
    const whatnot = new WhatnotService(account.name, account.whatnotToken);
    console.log('Fetching orders from Whatnot...');
    
    // Get orders from Whatnot
    const orders = await whatnot.getOrders();
    console.log(`Fetched ${orders.length} orders from Whatnot`);
    
    if (orders.length === 0) {
      console.log('No new orders to process');
      return { processed: 0, created: 0, invalid: 0, errors: [] };
    }
    
    // Validate orders
    console.log('Validating orders...');
    const validator = new OrderValidator();
    const { valid, invalid } = await validator.validateOrders(orders);
    
    console.log(`Validation results: ${valid.length} valid orders, ${invalid.length} invalid`);
    
    if (invalid.length > 0) {
      console.log('\nInvalid orders:');
      for (const item of invalid) {
        console.log(`- Order ${item.order.id}: ${item.errors.join(', ')}`);
      }
    }
    
    if (valid.length === 0) {
      console.log('No valid orders to create in ShipStation');
      return { processed: orders.length, created: 0, invalid: invalid.length, errors: [] };
    }
    
    // Initialize ShipStation service
    const shipstation = new ShipStationService();
    
    // Create orders in ShipStation
    console.log(`Creating ${valid.length} orders in ShipStation...`);
    const results = await shipstation.createOrders(
      valid, 
      account.whatnotToken, 
      account.shipstationStoreId
    );
    
    console.log(`\nCreated ${results.successful.length} orders in ShipStation`);
    console.log(`Failed to create ${results.failed.length} orders`);
    
    if (results.failed.length > 0) {
      console.log('\nFailed orders:');
      for (const failed of results.failed) {
        console.log(`- Stream ${failed.streamId}: ${failed.error}`);
      }
    }
    
    return {
      processed: orders.length,
      created: results.successful.length,
      invalid: invalid.length,
      errors: results.failed
    };
  } catch (error) {
    console.error(`Error processing account ${account.name}:`, error);
    return {
      processed: 0,
      created: 0,
      invalid: 0,
      errors: [{ accountId: account.name, error: error.message }]
    };
  }
}

/**
 * Main function to run the sync
 */
async function syncOrders() {
  console.log('=== Starting Whatnot to ShipStation order sync ===');
  console.log(`Time: ${new Date().toISOString()}`);
  
  try {
    // Load accounts
    const accounts = await loadAccounts();
    console.log(`Loaded ${accounts.length} accounts`);
    
    const results = {
      total: {
        processed: 0,
        created: 0,
        invalid: 0,
        errors: []
      },
      accounts: []
    };
    
    // Process each account
    for (const account of accounts) {
      const accountResult = await processAccount(account);
      
      // Add to totals
      results.total.processed += accountResult.processed;
      results.total.created += accountResult.created;
      results.total.invalid += accountResult.invalid;
      results.total.errors = results.total.errors.concat(accountResult.errors);
      
      // Save account result
      results.accounts.push({
        name: account.name,
        ...accountResult
      });
    }
    
    // Print summary
    console.log('\n=== Sync Complete ===');
    console.log(`Total orders processed: ${results.total.processed}`);
    console.log(`Total orders created in ShipStation: ${results.total.created}`);
    console.log(`Total invalid orders: ${results.total.invalid}`);
    console.log(`Total errors: ${results.total.errors.length}`);
    
    if (results.total.errors.length > 0) {
      console.log('\nErrors summary:');
      for (const error of results.total.errors) {
        if (error.accountId) {
          console.log(`- Account ${error.accountId}: ${error.error}`);
        } else if (error.streamId) {
          console.log(`- Stream ${error.streamId}: ${error.error}`);
        } else {
          console.log(`- Unknown: ${error}`);
        }
      }
    }
    
    console.log(`\nSync completed at ${new Date().toISOString()}`);
    return results;
  } catch (error) {
    console.error('Sync failed with error:', error);
    throw error;
  }
}

// Run the sync
syncOrders().catch(error => {
  console.error('Fatal error in sync process:', error);
  process.exit(1);
});