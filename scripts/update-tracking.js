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
  // Handle null, undefined or empty cases
  if (!carrierCode) return 'usps';
  
  // Convert to lowercase for consistent comparison
  const carrierLower = carrierCode.toLowerCase();
  
  // Check for specific patterns
  if (carrierLower.includes('ups')) {
    return 'ups';
  } else if (carrierLower.includes('stamps') || carrierLower.includes('usps')) {
    return 'usps';
  } else if (carrierLower.includes('fedex')) {
    return 'fedex';
  }
  
  // Default to USPS as fallback
  return 'usps';
}
/**
 * Process tracking updates for a single account with improved error handling
 * @param {Object} account - Account configuration
 * @param {Function} progressCallback - Optional callback for reporting progress
 * @returns {Promise<Object>} Results of tracking updates
 */
async function processAccount(account, progressCallback = null) {
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

    // Report fetch phase starting
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0,
          total: 0, // Unknown at this point
          updated: 0,
          errors: []
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: 0,
          updated: 0,
          errors: []
        }],
        phase: 'fetch',
        logOnly: true,
        logMessage: `Fetching shipped orders from ShipStation for ${account.name}...`
      });
    }

    // Get shipped orders with tracking from ShipStation
    console.log('Fetching shipped orders from ShipStation...');
    const { orders, total } = await shipstation.getShippedOrdersWithTracking(
      account.shipstationStoreId,
      { startDate: new Date(lastSyncTime).toISOString().split('T')[0] }
    );

    console.log(`Found ${total} shipments with tracking information`);

    // Filter out already processed shipments
    const filteredOrders = orders.filter(order =>
      !processedShipmentIds.includes(order.shipmentId)
    );

    if (lastProcessedShipmentId) {
      console.log(`Filtered out ${orders.length - filteredOrders.length} already processed shipments`);
    }

    // Report fetch phase completion
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0,
          total: filteredOrders.length,
          updated: 0,
          errors: []
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: filteredOrders.length,
          updated: 0,
          errors: []
        }],
        phase: 'fetch_complete',
        logOnly: false, // Set to false to update the progress bar with total count
        logMessage: `Found ${filteredOrders.length} new shipments to process for ${account.name}`
      });
    }

    if (filteredOrders.length === 0) {
      console.log('No new shipments to process');

      // Report completion progress to update the UI progress bar to 100% even when no new shipments
      if (progressCallback && typeof progressCallback === 'function') {
        progressCallback({
          total: {
            processed: 1,  // Set to 1 to show progress
            total: 1,      // Set to 1 for 100% calculation
            updated: 0,
            alreadyTracked: 0,
            errors: []
          },
          accounts: [{
            name: account.name,
            processed: 1,
            total: 1,
            updated: 0,
            alreadyTracked: 0,
            errors: []
          }],
          phase: 'complete',
          logMessage: 'No new shipments to process - all tracking is up to date'
        });
      }

      return { processed: 0, updated: 0, errors: [] };
    }

    // Process each shipment and update tracking on Whatnot
    const results = {
      processed: 0, // Start from 0 and increment for each processed shipment, regardless of outcome
      updated: 0,   // Count only successful updates (not already tracked)
      alreadyTracked: 0, // Count items that were already tracked
      errors: []    // Count only actual errors (not already tracked)
    };

    console.log('Updating tracking information on Whatnot...');

    // Keep track of newly processed shipments in this session
    const newlyProcessedShipmentIds = [...processedShipmentIds];

    // Process each shipment
    for (let i = 0; i < filteredOrders.length; i++) {
      const shipment = filteredOrders[i];
      const { trackingNumber, carrierCode, whatnotOrderIds } = shipment;

      // Skip if missing required info
      if (!trackingNumber || !whatnotOrderIds || whatnotOrderIds.length === 0) {
        console.log(`Skipping shipment ${shipment.shipmentId}: Missing required information`);
        results.errors.push({
          shipmentId: shipment.shipmentId,
          error: 'Missing tracking number or Whatnot order IDs'
        });

        // Still increment processed count and report progress
        results.processed++;

        if (progressCallback && typeof progressCallback === 'function') {
          reportProgress(progressCallback, account, results, filteredOrders.length, i,
            `Skipping shipment ${i + 1}/${filteredOrders.length}: Missing information`);
        }

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

        // Count this shipment as processed regardless of result
        results.processed++;

        // Add successful updates
        results.updated += updateResult.successful.length;

        // Handle failed updates - check for "already tracked" errors
        let alreadyTrackedCount = 0;
        let actualErrorCount = 0;

        if (updateResult.failed.length > 0) {
          for (const failed of updateResult.failed) {
            const isAlreadyTracked = failed.error &&
              (failed.error.includes('cannot override tracking code') ||
                failed.error.includes('already has tracking'));

            if (isAlreadyTracked) {
              // Count as "already tracked" rather than error
              alreadyTrackedCount += failed.orderIds.length;
              results.alreadyTracked += failed.orderIds.length;
              // Remove verbose logging for already tracked orders - not an error
            } else {
              // Count as actual error
              actualErrorCount += failed.orderIds.length;
              // Combine error messages into a single line
              const errorMsg = `Failed to update tracking for order(s) ${failed.orderIds.join(', ')}: ${failed.error}`;
              console.error(errorMsg);

              // Add specific error message for UI logging
              if (progressCallback && typeof progressCallback === 'function') {
                progressCallback({
                  logOnly: true,
                  logMessage: errorMsg,
                  logType: 'error'
                });
              }

              results.errors.push({
                shipmentId: shipment.shipmentId,
                orderIds: failed.orderIds,
                error: failed.error
              });
            }
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

        // Report progress
        if (progressCallback && typeof progressCallback === 'function') {
          let message = `Processed ${i + 1}/${filteredOrders.length}: `;
          if (updateResult.successful.length > 0) {
            message += `${updateResult.successful.length} updated`;
          }
          if (alreadyTrackedCount > 0) {
            message += `${updateResult.successful.length > 0 ? ', ' : ''}${alreadyTrackedCount} already tracked`;
          }
          if (actualErrorCount > 0) {
            message += `${(updateResult.successful.length > 0 || alreadyTrackedCount > 0) ? ', ' : ''}${actualErrorCount} errors`;
          }

          reportProgress(progressCallback, account, results, filteredOrders.length, i, message);
        }

      } catch (error) {
        // Still count as processed
        results.processed++;

        const errorMsg = `Error processing shipment ${shipment.shipmentId}: ${error.message}`;

        results.errors.push({
          shipmentId: shipment.shipmentId,
          orderIds: whatnotOrderIds,
          error: error.message
        });

        // Log error to UI
        if (progressCallback && typeof progressCallback === 'function') {
          // First send a specific error message for UI display
          progressCallback({
            logOnly: true,
            logMessage: errorMsg,
            logType: 'error'
          });

          // Then update progress as usual
          reportProgress(progressCallback, account, results, filteredOrders.length, i,
            `Error processing shipment ${i + 1}/${filteredOrders.length}: ${error.message}`);
        }
      }
    }

    // Only update the sync time if we've finished processing all shipments
    if (filteredOrders.length > 0) {
      const currentTime = new Date().toISOString();
      await shipstation.saveLastSyncTime(account.shipstationStoreId, currentTime);

      // Reset tracking state for next run
      await saveTrackingState(account.shipstationStoreId, {
        lastProcessedShipmentId: null,
        processedShipmentIds: [],
        lastSyncTime: currentTime
      });
      console.log('Reset tracking state for next run');
    }

    // Report final results
    console.log('\nTracking update results:');
    console.log(`- Total shipments processed: ${results.processed}`);
    console.log(`- Successfully updated: ${results.updated}`);
    console.log(`- Already tracked: ${results.alreadyTracked}`);
    console.log(`- Errors: ${results.errors.length}`);

    // Report completion
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: filteredOrders.length, // 100% complete
          total: filteredOrders.length,
          updated: results.updated,
          alreadyTracked: results.alreadyTracked,
          errors: results.errors
        },
        accounts: [{
          name: account.name,
          processed: filteredOrders.length, // 100% complete
          total: filteredOrders.length,
          updated: results.updated,
          alreadyTracked: results.alreadyTracked,
          errors: results.errors
        }],
        phase: 'complete',
        logMessage: `Completed tracking updates: ${results.updated} updated, ${results.alreadyTracked} already tracked, ${results.errors.length} errors.`
      });
    }

    return results;
  } catch (error) {
    console.error(`Error processing account ${account.name}:`, error);

    // Report error to callback
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0,
          total: 0,
          updated: 0,
          errors: [{ accountId: account.name, error: error.message }]
        },
        accounts: [{
          name: account.name,
          processed: 0,
          total: 0,
          updated: 0,
          errors: [{ error: error.message }]
        }],
        phase: 'error',
        logMessage: `Error processing account ${account.name}: ${error.message}`
      });
    }

    return {
      processed: 0,
      updated: 0,
      errors: [{ accountId: account.name, error: error.message }]
    };
  }
}

/**
 * Helper function to report progress in a consistent format
 */
function reportProgress(progressCallback, account, results, totalCount, currentIndex, message) {
  const processedCount = currentIndex + 1;
  const progressPercentage = Math.round((processedCount / totalCount) * 100);

  // Don't scale down the values - use the actual account-specific counts
  progressCallback({
    total: {
      processed: processedCount,
      total: totalCount,
      updated: results.updated,
      alreadyTracked: results.alreadyTracked || 0,
      errors: results.errors
    },
    accounts: [{
      name: account.name,
      processed: processedCount,
      total: totalCount,
      updated: results.updated,
      alreadyTracked: results.alreadyTracked || 0,
      errors: results.errors
    }],
    phase: 'update',
    logMessage: `Processed ${processedCount}/${totalCount}: ${results.alreadyTracked || 0} already tracked (${progressPercentage}%)`
  });
}

/**
 * Main function to run the tracking update
 * @param {Array<Object>} accountsToProcess - Optional array of accounts to process (default: all enabled accounts)
 * @param {Function} progressCallback - Optional callback for reporting progress
 * @returns {Promise<Object>} Results of the tracking update operation
 */
export async function updateTracking(accountsToProcess = null, progressCallback = null) {
  console.log('=== Starting ShipStation to Whatnot tracking update ===');
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
        updated: 0,
        errors: []
      },
      accounts: []
    };

    // Process each account
    for (const account of accounts) {
      // Pass a wrapped progressCallback that adds context for the overall progress
      const wrappedCallback = progressCallback && typeof progressCallback === 'function'
        ? (progress) => {
          // Only update total if we have account progress data
          if (progress.total && !progress.logOnly) {
            // Add this account's data to the overall results
            results.total.processed += progress.total.processed || 0;
            results.total.updated += progress.total.updated || 0;

            if (progress.total.errors && Array.isArray(progress.total.errors)) {
              results.total.errors = results.total.errors.concat(progress.total.errors);
            }

            // Find this account in the results or add it
            const accountResult = results.accounts.find(a => a.name === account.name);
            if (accountResult) {
              accountResult.processed = progress.accounts[0].processed;
              accountResult.total = progress.accounts[0].total;
              accountResult.updated = progress.accounts[0].updated;
              accountResult.errors = progress.accounts[0].errors;
            } else {
              results.accounts.push(progress.accounts[0]);
            }
          }

          // Pass both the account-specific progress and the overall results
          progressCallback({
            ...progress,
            total: results.total,
            accounts: results.accounts
          });
        }
        : null;

      const accountResult = await processAccount(account, wrappedCallback);

      // Add to totals if not already added by the wrapped callback
      if (!wrappedCallback) {
        results.total.processed += accountResult.processed;
        results.total.updated += accountResult.updated;
        results.total.errors = results.total.errors.concat(accountResult.errors);

        // Save account result
        results.accounts.push({
          name: account.name,
          ...accountResult
        });

        // Report progress if callback provided
        if (progressCallback && typeof progressCallback === 'function') {
          progressCallback({
            total: results.total,
            accounts: results.accounts,
            phase: 'account_complete',
            logMessage: `Completed processing account ${account.name}`
          });
        }
      }
    }

    // Print summary
    console.log('\n=== Tracking Update Complete ===');
    console.log(`Total shipments processed: ${results.total.processed}`);
    console.log(`Total orders updated in Whatnot: ${results.total.updated}`);
    console.log(`Total errors: ${results.total.errors.length}`);

    // Removed verbose error summary - errors are already logged individually

    // Final progress report
    if (progressCallback && typeof progressCallback === 'function') {
      // If no shipments were processed, ensure we still show 100% completion
      const finalTotal = results.total;
      if (finalTotal.processed === 0 && finalTotal.updated === 0 && finalTotal.errors.length === 0) {
        finalTotal.processed = 1;
        finalTotal.total = 1;
      }

      progressCallback({
        total: finalTotal,
        accounts: results.accounts,
        phase: 'complete',
        logMessage: finalTotal.processed === 0 ?
          'Tracking update completed. No new shipments to process.' :
          `Tracking update completed. Updated ${results.total.updated} orders with ${results.total.errors.length} errors.`
      });
    }

    console.log(`\nTracking update completed at ${new Date().toISOString()}`);
    return results;
  } catch (error) {
    // Report fatal error
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        total: {
          processed: 0,
          updated: 0,
          errors: [{ error: error.message }]
        },
        accounts: [],
        phase: 'error',
        logMessage: `Fatal error in tracking update: ${error.message}`
      });
    }

    throw error;
  }
}

// Run the tracking update if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateTracking().catch(error => {
    console.error('Fatal error in tracking update process:', error);
    process.exit(1);
  });
}