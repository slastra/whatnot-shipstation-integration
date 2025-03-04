import ShipStationService from '../services/shipstation.js';
import WhatnotService from '../services/whatnot.js';
import { loadTrackingState, saveTrackingState } from '../utils/tracking-state.js';
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
 * Convert ShipStation carrier code to Whatnot courier format
 * @param {string} carrierCode - ShipStation carrier code 
 * @returns {string} Whatnot courier format
 */
function mapCarrierToWhatnotCourier(carrierCode) {
  const mapping = {
    'USPS': 'usps',
    'UPS': 'ups',
    'FEDEX': 'fedex',
    'DHL': 'dhl'
  };
  
  return mapping[carrierCode] || 'usps'; // Default to USPS if unknown
}

/**
 * Process tracking updates for a single account
 * @param {Object} account - Account configuration
 * @returns {Promise<Object>} Results of tracking updates
 */
async function processAccount(account) {
  console.log(`\n=== Processing tracking updates for account: ${account.name} ===`);
  
  if (!account.enabled) {
    console.log('Account is disabled, skipping');
    return { processed: 0, updated: 0, errors: [] };
  }
  
  try {
    // Initialize services
    const shipstation = new ShipStationService();
    const whatnot = new WhatnotService(account.name, account.whatnotToken);
    
    // Get last sync time for this account's store
    const lastSyncTime = await shipstation.getLastSyncTime(account.shipstationStoreId);
    console.log(`Last sync time: ${lastSyncTime}`);
    
    // Load tracking state to resume from last processed shipment
    const trackingState = await loadTrackingState(account.shipstationStoreId);
    let lastProcessedShipmentId = null;
    let processedShipmentIds = [];
    
    if (trackingState) {
      lastProcessedShipmentId = trackingState.lastProcessedShipmentId;
      processedShipmentIds = trackingState.processedShipmentIds || [];
      console.log(`Resuming from last processed shipment ID: ${lastProcessedShipmentId}`);
      console.log(`Already processed ${processedShipmentIds.length} shipments in this session`);
    }
    
    // Get shipped orders with tracking from ShipStation
    console.log('Fetching shipped orders from ShipStation...');
    const { orders, total } = await shipstation.getShippedOrdersWithTracking(
      account.shipstationStoreId,
      { startDate: new Date(lastSyncTime).toISOString().split('T')[0] }
    );
    
    console.log(`Found ${total} shipments with tracking information`);
    
    if (orders.length === 0) {
      console.log('No new shipments to process');
      return { processed: 0, updated: 0, errors: [] };
    }
    
    // Filter out already processed shipments
    const filteredOrders = orders.filter(order => 
      !processedShipmentIds.includes(order.shipmentId)
    );
    
    if (lastProcessedShipmentId) {
      console.log(`Filtered out ${orders.length - filteredOrders.length} already processed shipments`);
    }
    
    // Process each shipment and update tracking on Whatnot
    const results = {
      processed: filteredOrders.length,
      updated: 0,
      errors: []
    };
    
    console.log('Updating tracking information on Whatnot...');
    
    // Keep track of newly processed shipments in this session
    const newlyProcessedShipmentIds = [...processedShipmentIds];
    
    for (const shipment of filteredOrders) {
      const { trackingNumber, carrierCode, whatnotOrderIds } = shipment;
      
      if (!trackingNumber || !whatnotOrderIds || whatnotOrderIds.length === 0) {
        console.log(`Skipping shipment ${shipment.shipmentId}: Missing required information`);
        results.errors.push({
          shipmentId: shipment.shipmentId,
          error: 'Missing tracking number or Whatnot order IDs'
        });
        continue;
      }
      
      try {
        const courier = mapCarrierToWhatnotCourier(carrierCode);
        console.log(`Updating tracking for orders: ${whatnotOrderIds.join(', ')}`);
        console.log(`Tracking: ${trackingNumber} (${courier})`);
        
        const updateResult = await whatnot.updateOrdersTracking(
          whatnotOrderIds.map(id => ({ id })),
          trackingNumber,
          courier
        );
        
        results.updated += updateResult.successful.length;
        
        if (updateResult.failed.length > 0) {
          for (const failed of updateResult.failed) {
            console.error(`Failed to update tracking for order(s): ${failed.orderIds.join(', ')}`);
            console.error(`Error: ${failed.error}`);
            
            results.errors.push({
              shipmentId: shipment.shipmentId,
              orderIds: failed.orderIds,
              error: failed.error
            });
          }
        }
        
        // Mark this shipment as processed
        newlyProcessedShipmentIds.push(shipment.shipmentId);
        
        // Save current progress after each shipment to enable resuming
        await saveTrackingState(account.shipstationStoreId, {
          lastProcessedShipmentId: shipment.shipmentId,
          processedShipmentIds: newlyProcessedShipmentIds,
          lastSyncTime: lastSyncTime
        });
        
      } catch (error) {
        console.error(`Error updating tracking for shipment ${shipment.shipmentId}:`, error);
        results.errors.push({
          shipmentId: shipment.shipmentId,
          orderIds: whatnotOrderIds,
          error: error.message
        });
      }
    }
    
    // Only update the sync time if we've finished processing all shipments
    if (filteredOrders.length > 0) {
      const currentTime = new Date().toISOString();
      await shipstation.saveLastSyncTime(account.shipstationStoreId, currentTime);
      
      // Reset tracking state for next run if all shipments processed successfully
      if (results.errors.length === 0) {
        await saveTrackingState(account.shipstationStoreId, {
          lastProcessedShipmentId: null,
          processedShipmentIds: [],
          lastSyncTime: currentTime
        });
        console.log('Reset tracking state for next run');
      }
    }
    
    return results;
  } catch (error) {
    console.error(`Error processing account ${account.name}:`, error);
    return {
      processed: 0,
      updated: 0,
      errors: [{ accountId: account.name, error: error.message }]
    };
  }
}

/**
 * Main function to run the tracking update
 */
async function updateTracking() {
  console.log('=== Starting ShipStation to Whatnot tracking update ===');
  console.log(`Time: ${new Date().toISOString()}`);
  
  try {
    // Load accounts
    const accounts = await loadAccounts();
    console.log(`Loaded ${accounts.length} accounts`);
    
    const results = {
      total: {
        processed: 0,
        updated: 0,
        errors: []
      },
      accounts: []
    };
    
    // Process each account
    for (const account of accounts) {
      const accountResult = await processAccount(account);
      
      // Add to totals
      results.total.processed += accountResult.processed;
      results.total.updated += accountResult.updated;
      results.total.errors = results.total.errors.concat(accountResult.errors);
      
      // Save account result
      results.accounts.push({
        name: account.name,
        ...accountResult
      });
    }
    
    // Print summary
    console.log('\n=== Tracking Update Complete ===');
    console.log(`Total shipments processed: ${results.total.processed}`);
    console.log(`Total orders updated in Whatnot: ${results.total.updated}`);
    console.log(`Total errors: ${results.total.errors.length}`);
    
    if (results.total.errors.length > 0) {
      console.log('\nErrors summary:');
      for (const error of results.total.errors) {
        if (error.accountId) {
          console.log(`- Account ${error.accountId}: ${error.error}`);
        } else if (error.shipmentId) {
          console.log(`- Shipment ${error.shipmentId}: ${error.error}`);
        } else {
          console.log(`- Unknown: ${error}`);
        }
      }
    }
    
    console.log(`\nTracking update completed at ${new Date().toISOString()}`);
    return results;
  } catch (error) {
    console.error('Tracking update failed with error:', error);
    throw error;
  }
}

// Run the tracking update
updateTracking().catch(error => {
  console.error('Fatal error in tracking update process:', error);
  process.exit(1);
});