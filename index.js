import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import 'dotenv/config';
import cron from 'node-cron';

// Sync and tracking modules
import { syncOrders } from './scripts/sync-orders.js';
import { updateTracking } from './scripts/update-tracking.js';

// ======== SERVER SETUP ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static files
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// ======== CONFIGURATION ========
const MAX_LOGS = 100;
const SYNC_SCHEDULE = process.env.SYNC_SCHEDULE || '0 1 * * *';  // Default: 1:00 AM daily
const TRACKING_SCHEDULE = process.env.TRACKING_SCHEDULE || '0 2 * * *';  // Default: 2:00 AM daily
const SCHEDULED_ACCOUNT = process.env.SCHEDULED_ACCOUNT || null; // Default account for scheduled jobs
const SYNC_ALL_ACCOUNTS = process.env.SYNC_ALL_ACCOUNTS === 'true' || false; // Whether to sync all enabled accounts

// ======== STATUS TRACKING ========
const syncStatus = {
  isRunning: false,
  type: null, // 'sync' or 'tracking'
  startTime: null,
  progress: {
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0
  },
  accounts: [],
  logs: [], // Store logs here
  scheduledRun: false, // Flag to indicate if this is a scheduled run
  currentAccountProgress: {
    processed: 0,
    successful: 0,
    failed: 0
  }
};

// ======== HELPER FUNCTIONS ========

// Load accounts from accounts.json
async function loadAccounts() {
  try {
    const accountsPath = join(__dirname, 'accounts.json');
    const data = await readFile(accountsPath, 'utf-8');
    return JSON.parse(data).accounts;
  } catch (error) {
    console.error('Error loading accounts:', error);
    return [];
  }
}

// Validate cron expression
function isValidCronExpression(cronExpression) {
  try {
    cron.validate(cronExpression);
    return true;
  } catch (error) {
    console.error(`Invalid cron expression: ${cronExpression}`, error);
    return false;
  }
}

// Get next scheduled run time
function getNextRunTime(cronExpression) {
  try {
    if (!isValidCronExpression(cronExpression)) {
      return 'Invalid schedule';
    }
    
    const task = cron.schedule(cronExpression, () => {});
    const nextDate = task.nextDate();
    task.stop();
    return nextDate.toISOString();
  } catch (error) {
    console.error('Error calculating next run time:', error);
    return 'Invalid schedule';
  }
}

// Add a log message to the status
function addLogMessage(message, type = 'info') {
  // Create log entry with timestamp
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message, type };

  // Check for duplicate messages (within last 5 seconds)
  const recentTime = new Date(Date.now() - 5000).toISOString();
  const isDuplicate = syncStatus.logs.some(entry =>
    entry.message === message &&
    entry.type === type &&
    entry.timestamp > recentTime
  );

  // Skip duplicates
  if (isDuplicate) {
    console.log(`Skipping duplicate log: [${type}] ${message}`);
    return;
  }

  // Add to the beginning (newest first)
  syncStatus.logs.unshift(logEntry);

  // Limit the number of logs
  if (syncStatus.logs.length > MAX_LOGS) {
    syncStatus.logs = syncStatus.logs.slice(0, MAX_LOGS);
  }

  console.log(`Log: [${type}] ${message}`);
}

// Reset sync status for a new operation
function resetSyncStatus(type, isScheduled) {
  syncStatus.isRunning = true;
  syncStatus.type = type;
  syncStatus.startTime = new Date().toISOString();
  syncStatus.scheduledRun = isScheduled;
  syncStatus.progress = { total: 0, processed: 0, successful: 0, failed: 0 };
  syncStatus.accounts = [];
  syncStatus.logs = [];
  syncStatus.currentAccountProgress = { processed: 0, successful: 0, failed: 0 };
}

// Get valid enabled accounts for processing
async function getEnabledAccounts(accountId = null) {
  const allAccounts = await loadAccounts();
  
  // If accountId specified, get just that account
  if (accountId) {
    const account = allAccounts.find(acc => acc.name === accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    if (!account.enabled) {
      throw new Error(`Account ${accountId} is disabled`);
    }
    return [account];
  }
  
  // Otherwise get all enabled accounts
  const enabledAccounts = allAccounts.filter(acc => acc.enabled);
  if (enabledAccounts.length === 0) {
    throw new Error('No enabled accounts found');
  }
  return enabledAccounts;
}

// ======== SYNC AND TRACKING FUNCTIONS ========

// Run sync orders for a single account
async function runSyncOrders(accountId, isScheduled = false) {
  if (syncStatus.isRunning) {
    return { success: false, error: 'A sync or tracking update is already running' };
  }

  try {
    // Reset status
    resetSyncStatus('sync', isScheduled);
    
    // Log start
    const runType = isScheduled ? 'scheduled' : 'manual';
    addLogMessage(`Starting ${runType} order sync for account: ${accountId}`);
    
    // Send initial status
    io.emit('status_update', syncStatus);
    
    // Get the account
    const [account] = await getEnabledAccounts(accountId);
    
    // Execute sync orders with progress callback
    const result = await syncOrders([account], (progress) => {
      handleSyncProgress(progress, account.name);
    });
    
    // Update final status
    syncStatus.isRunning = false;
    
    if (result && result.total) {
      syncStatus.progress = {
        total: result.total.total || 0,
        processed: result.total.total || 0, // Set to total for 100%
        successful: result.total.created || 0,
        failed: (result.total.errors && result.total.errors.length ? result.total.errors.length : 0) +
          (result.total.invalid || 0)
      };
      syncStatus.accounts = result.accounts || [];
    }
    
    // Add completion log
    addLogMessage(`Sync completed. Created ${result.total.created} orders successfully. ${result.total.errors.length} errors.`);
    
    // Send final status updates
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: true, result });
    
    return { success: true, result };
  } catch (error) {
    // Handle errors
    syncStatus.isRunning = false;
    addLogMessage(`Error: ${error.message}`, 'error');
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// Process sync progress updates
function handleSyncProgress(progress, accountName) {
  // Skip if this is just a log message
  if (progress.logMessage) {
    addLogMessage(progress.logMessage);
    
    // If log-only update, just send the status with new log
    if (progress.logOnly) {
      io.emit('status_update', syncStatus);
      return;
    }
  }
  
  // Process progress data if available
  if (progress && progress.total) {
    const progressData = progress.total;
    
    // Update progress values
    syncStatus.progress = {
      total: progressData.total || 0,
      processed: progress.phase === 'complete' ? progressData.total || 0 : progressData.processed || 0,
      successful: progressData.created || 0,
      failed: (progressData.errors && Array.isArray(progressData.errors) ? progressData.errors.length : 0) +
        (progressData.invalid || 0)
    };
    
    syncStatus.accounts = progress.accounts || [];
    
    // Calculate progress percentage for logging
    const progressPercentage = progress.phase === 'complete' ?
      100 : (progressData.total > 0 ? Math.round((progressData.processed / progressData.total) * 100) : 0);
    
    // Handle consolidation details
    if (progress.phase === 'creation' && progress.consolidation) {
      const consolidation = progress.consolidation;
      addLogMessage(`Created ${consolidation.actualCreatedCount}/${consolidation.estimatedShipStationCount} consolidated orders (${progressPercentage}% complete)`);
      syncStatus.consolidation = progress.consolidation;
    } else if (progress.phase === 'complete') {
      addLogMessage(`Sync complete (100%)`);
    }
    
    // Send status update
    io.emit('status_update', syncStatus);
  }
}

// Run tracking update for a single account
async function runTrackingUpdate(accountId, isScheduled = false) {
  if (syncStatus.isRunning) {
    return { success: false, error: 'A sync or tracking update is already running' };
  }

  try {
    // Reset status
    resetSyncStatus('tracking', isScheduled);
    
    // Log start
    const runType = isScheduled ? 'scheduled' : 'manual';
    addLogMessage(`Starting ${runType} tracking update for account: ${accountId}`);
    
    // Send initial status
    io.emit('status_update', syncStatus);
    
    // Get the account
    const [account] = await getEnabledAccounts(accountId);
    
    // Execute tracking update with progress callback
    const result = await updateTracking([account], (progress) => {
      handleTrackingProgress(progress, account.name);
    });
    
    // Update final status
    syncStatus.isRunning = false;
    
    // Calculate tracking totals
    const alreadyTracked = result.total.alreadyTracked || 0;
    const updated = result.total.updated || 0;
    
    // Set final totals from account-specific data if available
    if (result.accounts && result.accounts.length > 0) {
      let finalProcessed = 0, finalTotal = 0;
      
      result.accounts.forEach(account => {
        finalProcessed += (account.processed || 0);
        finalTotal += (account.total || 0);
      });
      
      syncStatus.progress = {
        processed: finalProcessed,
        total: finalTotal,
        successful: updated + alreadyTracked,
        failed: Array.isArray(result.total.errors) ? result.total.errors.length : 0
      };
    } else {
      // Use default values if no account data
      syncStatus.progress = {
        processed: result.total.processed || 0,
        total: result.total.processed || 0, // For 100% completion
        successful: updated + alreadyTracked,
        failed: Array.isArray(result.total.errors) ? result.total.errors.length : 0
      };
    }
    
    syncStatus.accounts = result.accounts || [];
    
    // Add completion log
    addLogMessage(`Tracking update completed. Updated ${updated} orders, ${alreadyTracked} already tracked, ${syncStatus.progress.failed} errors.`, 'success');
    
    // Send final status updates
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: true, result });
    
    return { success: true, result };
  } catch (error) {
    // Handle errors
    syncStatus.isRunning = false;
    addLogMessage(`Error: ${error.message}`, 'error');
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// Process tracking progress updates
function handleTrackingProgress(progress, accountName) {
  // Add log message if provided
  if (progress.logMessage) {
    const logType = progress.logType || 'info';
    addLogMessage(progress.logMessage, logType);
    
    // If log-only update, just send the status with new log
    if (progress.logOnly) {
      io.emit('status_update', syncStatus);
      return;
    }
  }
  
  // Process progress data if available
  if (progress && progress.total) {
    const progressData = progress.total;
    
    // Calculate success counts
    const alreadyTracked = progressData.alreadyTracked || 0;
    const updated = progressData.updated || 0;
    const totalSuccess = updated + alreadyTracked;
    
    // Get processed/total values, preferring account-specific data
    let processedValue = progressData.processed || 0;
    let totalValue = progressData.total || 0;
    
    if (progress.accounts && progress.accounts.length > 0) {
      const account = progress.accounts[0];
      processedValue = account.processed || 0;
      totalValue = account.total || 0;
    }
    
    // Update progress values
    syncStatus.progress = {
      processed: processedValue,
      total: totalValue,
      successful: totalSuccess,
      failed: Array.isArray(progressData.errors) ? progressData.errors.length : 0
    };
    
    // Ensure sensible values for total and processed
    if (syncStatus.progress.total <= 0 && syncStatus.progress.processed > 0) {
      syncStatus.progress.total = syncStatus.progress.processed;
    }
    if (syncStatus.progress.processed > syncStatus.progress.total && syncStatus.progress.total > 0) {
      syncStatus.progress.processed = syncStatus.progress.total;
    }
    
    // Scale down large numbers
    if (syncStatus.progress.total > 10000) {
      const ratio = syncStatus.progress.processed / syncStatus.progress.total;
      syncStatus.progress.total = 100;
      syncStatus.progress.processed = Math.round(ratio * 100);
    }
    
    syncStatus.accounts = progress.accounts || [];
    syncStatus.trackingDetails = {
      updated: updated,
      alreadyTracked: alreadyTracked,
      phase: progress.phase
    };
    
    // Send status update
    io.emit('status_update', syncStatus);
  }
}

// Run sync orders for multiple accounts
async function runAllSyncOrders(isScheduled = false) {
  if (syncStatus.isRunning) {
    return { success: false, error: 'A sync or tracking update is already running' };
  }

  try {
    // Reset status
    resetSyncStatus('sync', isScheduled);
    
    // Get all enabled accounts
    const enabledAccounts = await getEnabledAccounts();
    
    // Log start
    const runType = isScheduled ? 'scheduled' : 'manual';
    addLogMessage(`Starting ${runType} order sync for all ${enabledAccounts.length} enabled accounts`);
    addLogMessage(`Accounts to process: ${enabledAccounts.map(acc => acc.name).join(', ')}`);
    
    // Send initial status
    io.emit('status_update', syncStatus);
    
    // Initialize results
    const overallResults = {
      success: true,
      accounts: [],
      total: { total: 0, processed: 0, created: 0, errors: [] }
    };
    
    // Process each account sequentially
    for (let i = 0; i < enabledAccounts.length; i++) {
      const account = enabledAccounts[i];
      
      try {
        addLogMessage(`Starting sync for account ${i+1}/${enabledAccounts.length}: ${account.name}`);
        
        // Reset account-specific progress tracker
        syncStatus.currentAccountProgress = { processed: 0, successful: 0, failed: 0 };
        
        // Run sync for this account
        const result = await syncOrders([account], (progress) => {
          // Add account name to log messages
          if (progress.logMessage) {
            progress.logMessage = `[${account.name}] ${progress.logMessage}`;
          }
          handleMultiAccountSyncProgress(progress, account.name);
        });
        
        // Add account result to overall results
        overallResults.accounts.push({
          name: account.name,
          success: true,
          ...result
        });
        
        // Aggregate statistics
        if (result && result.total) {
          overallResults.total.total += result.total.total || 0;
          overallResults.total.processed += result.total.processed || 0;
          overallResults.total.created += result.total.created || 0;
          
          if (result.total.errors && Array.isArray(result.total.errors)) {
            // Add account name to each error
            const accountErrors = result.total.errors.map(err => ({
              account: account.name,
              ...err
            }));
            overallResults.total.errors.push(...accountErrors);
          }
        }
        
        addLogMessage(`Completed sync for account ${account.name}. Created ${result.total.created} orders successfully. ${result.total.errors.length} errors.`);
      } catch (error) {
        // Log but continue to next account
        console.error(`Error syncing account ${account.name}:`, error);
        addLogMessage(`Error syncing account ${account.name}: ${error.message}`, 'error');
        
        // Mark as failed but continue
        overallResults.accounts.push({
          name: account.name,
          success: false,
          error: error.message
        });
        
        overallResults.success = false;
      }
    }
    
    // Update final status
    syncStatus.isRunning = false;
    syncStatus.progress = {
      total: overallResults.total.total || 0,
      processed: overallResults.total.processed || 0,
      successful: overallResults.total.created || 0,
      failed: overallResults.total.errors.length || 0
    };
    
    syncStatus.accounts = overallResults.accounts.map(acc => ({
      name: acc.name,
      success: acc.success
    }));
    
    // Add completion log
    addLogMessage(`Multi-account sync completed. Created ${overallResults.total.created} orders successfully across ${enabledAccounts.length} accounts. ${overallResults.total.errors.length} total errors.`);
    
    // Send final status updates
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: overallResults.success, result: overallResults });
    
    return overallResults;
  } catch (error) {
    // Handle errors
    syncStatus.isRunning = false;
    addLogMessage(`Error: ${error.message}`, 'error');
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// Process multi-account sync progress updates
function handleMultiAccountSyncProgress(progress, accountName) {
  // Skip if this is just a log message
  if (progress.logMessage) {
    addLogMessage(progress.logMessage);
    
    // If log-only update, just send the status with new log
    if (progress.logOnly) {
      io.emit('status_update', syncStatus);
      return;
    }
  }
  
  // Process progress data if available
  if (progress && progress.total) {
    const progressData = progress.total;
    
    // Calculate current progress values
    const currentProcessed = progress.phase === 'complete' ? progressData.total || 0 : progressData.processed || 0;
    const currentSuccessful = progressData.created || 0;
    const currentFailed = (progressData.errors && Array.isArray(progressData.errors) ? progressData.errors.length : 0) +
      (progressData.invalid || 0);
    
    // Update overall progress by incrementing with changes from last update
    syncStatus.progress.processed += currentProcessed - (syncStatus.currentAccountProgress?.processed || 0);
    syncStatus.progress.successful += currentSuccessful - (syncStatus.currentAccountProgress?.successful || 0);
    syncStatus.progress.failed += currentFailed - (syncStatus.currentAccountProgress?.failed || 0);
    
    // Store current values for next update
    syncStatus.currentAccountProgress = {
      processed: currentProcessed,
      successful: currentSuccessful,
      failed: currentFailed
    };
    
    syncStatus.accounts = progress.accounts || [];
    
    // Update consolidation info if available
    if (progress.phase === 'creation' && progress.consolidation) {
      syncStatus.consolidation = progress.consolidation;
    }
    
    // Send status update
    io.emit('status_update', syncStatus);
  }
}

// Run tracking update for multiple accounts
async function runAllTrackingUpdates(isScheduled = false) {
  if (syncStatus.isRunning) {
    return { success: false, error: 'A sync or tracking update is already running' };
  }

  try {
    // Reset status
    resetSyncStatus('tracking', isScheduled);
    
    // Get all enabled accounts
    const enabledAccounts = await getEnabledAccounts();
    
    // Log start
    const runType = isScheduled ? 'scheduled' : 'manual';
    addLogMessage(`Starting ${runType} tracking update for all ${enabledAccounts.length} enabled accounts`);
    addLogMessage(`Accounts to process: ${enabledAccounts.map(acc => acc.name).join(', ')}`);
    
    // Send initial status
    io.emit('status_update', syncStatus);
    
    // Initialize results
    const overallResults = {
      success: true,
      accounts: [],
      total: { total: 0, processed: 0, updated: 0, alreadyTracked: 0, errors: [] }
    };
    
    // Process each account sequentially
    for (let i = 0; i < enabledAccounts.length; i++) {
      const account = enabledAccounts[i];
      
      try {
        addLogMessage(`Starting tracking update for account ${i+1}/${enabledAccounts.length}: ${account.name}`);
        
        // Reset account-specific progress tracker
        syncStatus.currentAccountProgress = { processed: 0, successful: 0, failed: 0 };
        
        // Run tracking update for this account
        const result = await updateTracking([account], (progress) => {
          // Add account name to log messages
          if (progress.logMessage) {
            const logType = progress.logType || 'info';
            progress.logMessage = `[${account.name}] ${progress.logMessage}`;
            progress.logType = logType;
          }
          handleMultiAccountTrackingProgress(progress, account.name);
        });
        
        // Add account result to overall results
        overallResults.accounts.push({
          name: account.name,
          success: true,
          ...result
        });
        
        // Aggregate statistics
        if (result && result.total) {
          overallResults.total.total += result.total.total || 0;
          overallResults.total.processed += result.total.processed || 0;
          overallResults.total.updated += result.total.updated || 0;
          overallResults.total.alreadyTracked += result.total.alreadyTracked || 0;
          
          if (result.total.errors && Array.isArray(result.total.errors)) {
            // Add account name to each error
            const accountErrors = result.total.errors.map(err => ({
              account: account.name,
              ...err
            }));
            overallResults.total.errors.push(...accountErrors);
          }
        }
        
        addLogMessage(`Completed tracking update for account ${account.name}. Updated ${result.total.updated} orders, ${result.total.alreadyTracked} already tracked, ${result.total.errors.length} errors.`);
      } catch (error) {
        // Log but continue to next account
        console.error(`Error updating tracking for account ${account.name}:`, error);
        addLogMessage(`Error updating tracking for account ${account.name}: ${error.message}`, 'error');
        
        // Mark as failed but continue
        overallResults.accounts.push({
          name: account.name,
          success: false,
          error: error.message
        });
        
        overallResults.success = false;
      }
    }
    
    // Update final status
    syncStatus.isRunning = false;
    syncStatus.progress = {
      total: overallResults.total.total || 0,
      processed: overallResults.total.processed || 0,
      successful: overallResults.total.updated + overallResults.total.alreadyTracked || 0,
      failed: overallResults.total.errors.length || 0
    };
    
    syncStatus.accounts = overallResults.accounts.map(acc => ({
      name: acc.name,
      success: acc.success
    }));
    
    // Add completion log
    addLogMessage(`Multi-account tracking update completed. Updated ${overallResults.total.updated} orders, ${overallResults.total.alreadyTracked} already tracked across ${enabledAccounts.length} accounts. ${overallResults.total.errors.length} total errors.`);
    
    // Send final status updates
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: overallResults.success, result: overallResults });
    
    return overallResults;
  } catch (error) {
    // Handle errors
    syncStatus.isRunning = false;
    addLogMessage(`Error: ${error.message}`, 'error');
    io.emit('status_update', syncStatus);
    io.emit('sync_complete', { success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// Process multi-account tracking progress updates
function handleMultiAccountTrackingProgress(progress, accountName) {
  // Add log message if provided
  if (progress.logMessage) {
    const logType = progress.logType || 'info';
    addLogMessage(progress.logMessage, logType);
    
    // If log-only update, just send the status with new log
    if (progress.logOnly) {
      io.emit('status_update', syncStatus);
      return;
    }
  }
  
  // Process progress data if available
  if (progress && progress.total) {
    const progressData = progress.total;
    
    // Calculate current progress values
    const alreadyTracked = progressData.alreadyTracked || 0;
    const updated = progressData.updated || 0;
    const totalSuccess = updated + alreadyTracked;
    
    // Get processed/total values, preferring account-specific data
    let processedValue = progressData.processed || 0;
    let totalValue = progressData.total || 0;
    
    if (progress.accounts && progress.accounts.length > 0) {
      const account = progress.accounts[0];
      processedValue = account.processed || 0;
      totalValue = account.total || 0;
    }
    
    // Calculate changes
    const currentProcessed = processedValue;
    const currentSuccessful = totalSuccess;
    const currentFailed = Array.isArray(progressData.errors) ? progressData.errors.length : 0;
    
    // Update overall progress by incrementing with changes from last update
    syncStatus.progress.processed += currentProcessed - (syncStatus.currentAccountProgress?.processed || 0);
    syncStatus.progress.successful += currentSuccessful - (syncStatus.currentAccountProgress?.successful || 0);
    syncStatus.progress.failed += currentFailed - (syncStatus.currentAccountProgress?.failed || 0);
    
    // Store current values for next update
    syncStatus.currentAccountProgress = {
      processed: currentProcessed,
      successful: currentSuccessful,
      failed: currentFailed
    };
    
    syncStatus.accounts = progress.accounts || [];
    syncStatus.trackingDetails = {
      updated: updated,
      alreadyTracked: alreadyTracked,
      phase: progress.phase
    };
    
    // Send status update
    io.emit('status_update', syncStatus);
  }
}

// ======== SCHEDULING ========

// Initialize scheduled jobs
async function initializeScheduledJobs() {
  // Validate cron expressions
  if (!isValidCronExpression(SYNC_SCHEDULE)) {
    console.error(`Invalid sync schedule cron expression: ${SYNC_SCHEDULE}`);
    return;
  }
  
  if (!isValidCronExpression(TRACKING_SCHEDULE)) {
    console.error(`Invalid tracking schedule cron expression: ${TRACKING_SCHEDULE}`);
    return;
  }

  try {
    if (SYNC_ALL_ACCOUNTS) {
      // Multi-account mode
      const enabledAccounts = await getEnabledAccounts();
      console.log(`Scheduling jobs for all ${enabledAccounts.length} enabled accounts`);
      console.log(`Order sync scheduled for: ${SYNC_SCHEDULE}`);
      console.log(`Tracking update scheduled for: ${TRACKING_SCHEDULE}`);

      // Schedule jobs for all accounts
      scheduleJob(SYNC_SCHEDULE, 'sync', true);
      scheduleJob(TRACKING_SCHEDULE, 'tracking', true);
      
      console.log('Scheduled jobs for all accounts initialized successfully');
    } else if (SCHEDULED_ACCOUNT) {
      // Single account mode
      const [account] = await getEnabledAccounts(SCHEDULED_ACCOUNT);
      
      console.log(`Scheduling jobs for single account: ${SCHEDULED_ACCOUNT}`);
      console.log(`Order sync scheduled for: ${SYNC_SCHEDULE}`);
      console.log(`Tracking update scheduled for: ${TRACKING_SCHEDULE}`);

      // Schedule jobs for single account
      scheduleJob(SYNC_SCHEDULE, 'sync', false);
      scheduleJob(TRACKING_SCHEDULE, 'tracking', false);
      
      console.log('Scheduled jobs for single account initialized successfully');
    } else {
      console.log('No scheduled account or multi-account mode configured. Scheduled jobs will not run.');
    }
  } catch (error) {
    console.error('Error initializing scheduled jobs:', error);
  }
}

// Schedule a job with error handling
function scheduleJob(cronExpression, jobType, forAllAccounts) {
  cron.schedule(cronExpression, async () => {
    try {
      const timestamp = new Date().toISOString();
      let result;
      
      if (forAllAccounts) {
        console.log(`Running scheduled ${jobType} for all enabled accounts at ${timestamp}`);
        result = jobType === 'sync' 
          ? await runAllSyncOrders(true)
          : await runAllTrackingUpdates(true);
        
        const accountCount = result.accounts ? result.accounts.length : 0;
        console.log(`Scheduled ${jobType} for all accounts completed with status: ${result.success ? 'success' : 'failure'}`);
        if (!result.success) {
          console.error(`Scheduled ${jobType} had errors: ${result.error || 'See individual account results'}`);
        }
      } else {
        console.log(`Running scheduled ${jobType} for ${SCHEDULED_ACCOUNT} at ${timestamp}`);
        result = jobType === 'sync'
          ? await runSyncOrders(SCHEDULED_ACCOUNT, true)
          : await runTrackingUpdate(SCHEDULED_ACCOUNT, true);
          
        console.log(`Scheduled ${jobType} completed with status: ${result.success ? 'success' : 'failure'}`);
        if (!result.success) {
          console.error(`Scheduled ${jobType} failed: ${result.error}`);
        }
      }
      
      // Here you could add notifications for failures
    } catch (error) {
      console.error(`Unexpected error in scheduled ${jobType}:`, error);
    }
  });
}

// ======== API ROUTES ========

// Get all accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await loadAccounts();
    res.json({
      accounts: accounts.map(acc => ({
        id: acc.name,
        name: acc.name,
        enabled: acc.enabled
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current status
app.get('/api/status', (req, res) => {
  res.json(syncStatus);
});

// Get schedule configuration
app.get('/api/schedule', async (req, res) => {
  try {
    // Prepare schedule info
    let accountStatus = 'not_configured';
    let accountMessage = 'No scheduled account configured';
    let scheduledAccounts = [];
    
    if (SYNC_ALL_ACCOUNTS) {
      // Multi-account mode
      const accounts = await loadAccounts();
      const enabledAccounts = accounts.filter(acc => acc.enabled);
      
      if (enabledAccounts.length === 0) {
        accountStatus = 'no_enabled_accounts';
        accountMessage = 'No enabled accounts found for scheduled sync';
      } else {
        accountStatus = 'valid';
        accountMessage = `${enabledAccounts.length} accounts will be processed during scheduled runs`;
        scheduledAccounts = enabledAccounts.map(acc => acc.name);
      }
    } else if (SCHEDULED_ACCOUNT) {
      // Single account mode
      try {
        await getEnabledAccounts(SCHEDULED_ACCOUNT);
        accountStatus = 'valid';
        accountMessage = `Scheduled account '${SCHEDULED_ACCOUNT}' is valid and enabled`;
        scheduledAccounts = [SCHEDULED_ACCOUNT];
      } catch (error) {
        accountStatus = error.message.includes('disabled') ? 'disabled' : 'invalid';
        accountMessage = error.message;
      }
    }
    
    // Validate cron expressions
    const isSyncScheduleValid = isValidCronExpression(SYNC_SCHEDULE);
    const isTrackingScheduleValid = isValidCronExpression(TRACKING_SCHEDULE);
    
    res.json({
      syncSchedule: SYNC_SCHEDULE,
      syncScheduleValid: isSyncScheduleValid,
      trackingSchedule: TRACKING_SCHEDULE,
      trackingScheduleValid: isTrackingScheduleValid,
      syncAllAccounts: SYNC_ALL_ACCOUNTS,
      scheduledAccount: SCHEDULED_ACCOUNT,
      scheduledAccounts: scheduledAccounts,
      accountStatus: accountStatus,
      accountMessage: accountMessage,
      nextSyncRun: isSyncScheduleValid ? getNextRunTime(SYNC_SCHEDULE) : 'Invalid schedule',
      nextTrackingRun: isTrackingScheduleValid ? getNextRunTime(TRACKING_SCHEDULE) : 'Invalid schedule',
      scheduledJobsEnabled: accountStatus === 'valid' && isSyncScheduleValid && isTrackingScheduleValid
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual sync request
app.post('/api/sync', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    if (syncStatus.isRunning) {
      return res.status(409).json({ error: 'A sync or tracking update is already running' });
    }

    // Start sync process (non-blocking)
    res.json({ message: 'Order sync started', status: syncStatus });
    
    // Run in background
    runSyncOrders(accountId, false);
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual tracking update request
app.post('/api/tracking', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    if (syncStatus.isRunning) {
      return res.status(409).json({ error: 'A sync or tracking update is already running' });
    }

    // Start tracking process (non-blocking)
    res.json({ message: 'Tracking update started', status: syncStatus });
    
    // Run in background
    runTrackingUpdate(accountId, false);
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger a scheduled job
app.post('/api/run-scheduled', async (req, res) => {
  try {
    const { jobType } = req.body;
    
    if (syncStatus.isRunning) {
      return res.status(409).json({ error: 'A sync or tracking update is already running' });
    }
    
    if (jobType !== 'sync' && jobType !== 'tracking') {
      return res.status(400).json({ error: 'Invalid job type. Use "sync" or "tracking"' });
    }
    
    let result;
    
    // Choose appropriate function based on mode and job type
    if (SYNC_ALL_ACCOUNTS) {
      result = jobType === 'sync'
        ? await runAllSyncOrders(true)
        : await runAllTrackingUpdates(true);
        
      res.json({ 
        message: `Scheduled ${jobType} job triggered manually for all accounts`,
        status: result
      });
    } else if (SCHEDULED_ACCOUNT) {
      result = jobType === 'sync'
        ? await runSyncOrders(SCHEDULED_ACCOUNT, true)
        : await runTrackingUpdate(SCHEDULED_ACCOUNT, true);
        
      res.json({ 
        message: `Scheduled ${jobType} job triggered manually`,
        status: result
      });
    } else {
      return res.status(400).json({ 
        error: 'No scheduled account or multi-account mode configured',
        details: 'Set either SCHEDULED_ACCOUNT or SYNC_ALL_ACCOUNTS environment variables'
      });
    }
  } catch (error) {
    console.error('Error triggering scheduled job:', error);
    res.status(500).json({ error: error.message });
  }
});

// ======== SOCKET.IO ========

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('status_update', syncStatus);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ======== SERVER STARTUP ========

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await initializeScheduledJobs();
});
