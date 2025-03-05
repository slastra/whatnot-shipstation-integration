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
async function processAccount(account, progressCallback = null) {
  console.log(`\n=== Processing account: ${account.name} ===`);
  
  if (!account.enabled) {
    console.log('Account is disabled, skipping');
    return { processed: 0, created: 0, invalid: 0, errors: [] };
  }
  
  try {
    // Initialize Whatnot service
    const whatnot = new WhatnotService(account.name, account.whatnotToken);
    console.log('Fetching orders from Whatnot...');
    
    // Get orders from Whatnot - should represent 1/4 of total progress
    const orders = await whatnot.getOrders();
    console.log(`Fetched ${orders.length} orders from Whatnot`);
    
    // Report fetch phase completion to logs, but don't update UI progress
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0, // Start at 0% for UI progress
          total: orders.length,
          created: 0,
          invalid: 0,
          errors: []
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: orders.length,
          created: 0,
          invalid: 0,
          errors: []
        }],
        phase: 'fetch',
        logOnly: true, // Flag to indicate this is just for logging, not UI progress
        logMessage: `Fetched ${orders.length} orders from Whatnot`
      });
    }
    
    if (orders.length === 0) {
      console.log('No new orders to process');
      return { processed: 0, created: 0, invalid: 0, errors: [] };
    }
    
    // Validate orders
    console.log('Validating orders...');
    const validator = new OrderValidator();
    const { valid, invalid } = await validator.validateOrders(orders);
    
    console.log(`Validation results: ${valid.length} valid orders, ${invalid.length} invalid`);
    
    // Report validation phase completion to logs, but don't update UI progress
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0, // Keep at 0% for UI progress
          total: orders.length,
          created: 0,
          invalid: invalid.length,
          errors: []
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: orders.length,
          created: 0,
          invalid: invalid.length,
          errors: []
        }],
        phase: 'validation',
        logOnly: true, // Flag to indicate this is just for logging, not UI progress
        logMessage: `Validated orders: ${valid.length} valid, ${invalid.length} invalid`
      });
    }
    
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
    
    // Create orders in ShipStation - this is the only phase where we'll show UI progress
    console.log(`Creating ${valid.length} orders in ShipStation (consolidated from ${orders.length} Whatnot orders)...`);
    
    // Before creation, estimate the number of ShipStation orders that will be created
    // based on account-specific consolidation rules
    // This is a placeholder - in a real implementation, you'd calculate this based on your business logic
    const estimatedShipStationOrderCount = Math.ceil(valid.length * 0.4); // Example: 40% of Whatnot orders after consolidation
    console.log(`Estimated ${estimatedShipStationOrderCount} ShipStation orders after consolidation`);
    
    // Log this phase start but don't update UI progress yet
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0, // Start at 0% for UI progress
          total: orders.length,
          created: 0,
          invalid: invalid.length,
          errors: []
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: orders.length,
          created: 0,
          invalid: invalid.length,
          errors: []
        }],
        phase: 'creation_start',
        logOnly: true,
        logMessage: `Starting to create ShipStation orders. Consolidating ${valid.length} Whatnot orders into approximately ${estimatedShipStationOrderCount} ShipStation orders.`
      });
    }
    
    // Incremental progress updates during ShipStation order creation
    const results = await shipstation.createOrders(
      valid, 
      account.whatnotToken, 
      account.shipstationStoreId,
      // Progress callback for ShipStation service
      (progress) => {
        if (progressCallback && typeof progressCallback === 'function') {
          // Get the real grouped order count once it's available
          const actualGroupedCount = progress && progress.groupedCount ? progress.groupedCount : estimatedShipStationOrderCount;
          
          // Get the actual number of orders created so far
          const created = progress ? progress.created : 0;
          
          // Calculate progress based on the consolidated order count
          // creationProgress is a value between 0-1 representing how far into the creation process we are
          const creationProgress = actualGroupedCount > 0 ? 
            Math.min(created / actualGroupedCount, 1) : 0;
          
          // Calculate UI progress based entirely on creation phase
          // Now instead of 25-100%, it's 0-100% since we're not showing progress for the first phases
          const processedForUI = Math.floor(orders.length * creationProgress);
          
          // Log the actual calculation for debugging
          console.log(`Progress calculation: ${created}/${actualGroupedCount} consolidated orders = ${Math.round(creationProgress * 100)}% creation progress`);
          console.log(`UI progress: ${Math.round(creationProgress * 100)}% of total`);
          
          // Create progress update object
          const progressUpdate = {
            total: {
              processed: processedForUI,
              total: orders.length,
              created: created,
              invalid: invalid.length,
              errors: progress && progress.failed ? progress.failed : []
            },
            accounts: [{
              name: account.name,
              processed: processedForUI,
              total: orders.length,
              created: created,
              invalid: invalid.length,
              errors: progress && progress.failed ? progress.failed : []
            }],
            phase: 'creation',
            consolidation: {
              whatnotCount: orders.length,
              validCount: valid.length,
              estimatedShipStationCount: actualGroupedCount,
              actualCreatedCount: created
            },
            logMessage: `Created ${created}/${actualGroupedCount} ShipStation orders (${Math.round(creationProgress * 100)}% complete)`
          };
          
          progressCallback(progressUpdate);
        }
      }
    );
    
    console.log(`\nCreated ${results.successful.length} orders in ShipStation`);
    console.log(`Failed to create ${results.failed.length} orders`);
    
    // Report final completion
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: orders.length, // 100% complete
          total: orders.length,
          created: results.successful.length,
          invalid: invalid.length,
          errors: results.failed.length > 0 ? results.failed : []
        },
        accounts: [{
          name: account.name,
          processed: orders.length, // 100% complete
          total: orders.length,
          created: results.successful.length,
          invalid: invalid.length,
          errors: results.failed.length > 0 ? results.failed : []
        }],
        phase: 'complete',
        logMessage: `Completed creation of ${results.successful.length} ShipStation orders. ${results.failed.length} failed.`
      });
    }
    
    // Log any failed orders in detail
    if (results.failed.length > 0) {
      console.log('\nFailed orders - detailed breakdown:');
      for (const failed of results.failed) {
        console.log(`Stream: ${failed.streamId}`);
        console.log(`Order IDs: ${failed.whatnotIds ? failed.whatnotIds.join(', ') : 'Unknown'}`);
        console.log(`Error: ${typeof failed.error === 'string' ? failed.error : JSON.stringify(failed.error)}`);
        console.log('---');
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
 * @param {Array<Object>} accountsToProcess - Optional array of accounts to process (default: all enabled accounts)
 * @param {Function} progressCallback - Optional callback for reporting progress
 * @returns {Promise<Object>} Results of the sync operation
 */
export async function syncOrders(accountsToProcess = null, progressCallback = null) {
  console.log('=== Starting Whatnot to ShipStation order sync ===');
  console.log(`Time: ${new Date().toISOString()}`);
  
  try {
    // Load accounts
    let accounts = accountsToProcess;
    if (!accounts) {
      accounts = await loadAccounts();
      accounts = accounts.filter(acc => acc.enabled);
    }
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
      // Pass the progress callback to processAccount so it can report intermediate progress
      const accountResult = await processAccount(account, progressCallback);
      
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
      
      // Report final progress for this account
      if (progressCallback && typeof progressCallback === 'function') {
        console.log('Reporting final progress from syncOrders:', JSON.stringify(results.total));
        progressCallback({
          total: results.total,
          accounts: results.accounts,
          phase: 'complete'
        });
      }
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

// Run the sync if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncOrders().catch(error => {
    console.error('Fatal error in sync process:', error);
    process.exit(1);
  });
}