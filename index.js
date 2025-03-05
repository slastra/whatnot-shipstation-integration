import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import 'dotenv/config';

// Sync and tracking modules
import { syncOrders } from './scripts/sync-orders.js';
import { updateTracking } from './scripts/update-tracking.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create Express app, HTTP server, and Socket.io server
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static files
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// Status tracking
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
  logs: [] // Store logs here
};

// Max number of logs to keep
const MAX_LOGS = 100;

// Get accounts
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

// API routes
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

app.get('/api/status', (req, res) => {
  console.log('Returning status:', JSON.stringify(syncStatus));
  res.json(syncStatus);
});

app.post('/api/sync', async (req, res) => {
  if (syncStatus.isRunning) {
    return res.status(409).json({ error: 'A sync or tracking update is already running' });
  }

  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    // Reset status
    syncStatus.isRunning = true;
    syncStatus.type = 'sync';
    syncStatus.startTime = new Date().toISOString();

    // Reset progress properties
    syncStatus.progress = {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0
    };
    syncStatus.accounts = [];
    syncStatus.logs = []; // Clear logs

    // Add initial log
    addLogMessage(`Starting order sync for account: ${accountId}`);

    console.log('Reset status for sync:', JSON.stringify(syncStatus));

    // Send initial status
    io.emit('status_update', syncStatus);

    // Start sync process (non-blocking)
    res.json({ message: 'Order sync started', status: syncStatus });

    // Run the sync
    const accounts = await loadAccounts();
    const account = accounts.find(acc => acc.name === accountId);

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    // Execute sync orders
    syncOrders([account], (progress) => {
      // Log all progress for debugging
      console.log(`Progress callback received from sync-orders (phase: ${progress.phase || 'unknown'})`,
        JSON.stringify(progress.total));

      // Add log message if provided
      if (progress.logMessage) {
        addLogMessage(progress.logMessage);
      }

      // If this is a log-only update, don't update the UI progress
      if (progress.logOnly) {
        // Only emit the log update
        io.emit('status_update', syncStatus);
        return;
      }

      // Update UI progress for phases that should show progress
      if (progress && progress.total) {
        const progressData = progress.total;

        // Map the properties appropriately for the UI
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
          100 : // Always 100% for complete phase
          (progressData.total > 0 ? Math.round((progressData.processed / progressData.total) * 100) : 0);

        // Add consolidation details to the log and syncStatus if available
        let logMessage = `Progress: ${progressPercentage}%`;

        if (progress.phase === 'creation' && progress.consolidation) {
          const consolidation = progress.consolidation;
          logMessage = `Created ${consolidation.actualCreatedCount}/${consolidation.estimatedShipStationCount} consolidated orders (${progressPercentage}% complete)`;

          // Add additional consolidation info to the syncStatus
          syncStatus.consolidation = progress.consolidation;
        } else if (progress.phase === 'complete') {
          logMessage = `Sync complete (100%)`;
        }

        console.log(logMessage);
        io.emit('status_update', syncStatus);
      }
    }).then(result => {
      // Log the final result
      console.log('Sync completed with result:', JSON.stringify(result));

      // Update final status
      syncStatus.isRunning = false;

      // Set final progress using the result data
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

      console.log('Final status update:', JSON.stringify(syncStatus.progress));
      io.emit('status_update', syncStatus);
      io.emit('sync_complete', { success: true, result });
    }).catch(error => {
      console.error('Sync error:', error);
      // Update error status
      syncStatus.isRunning = false;

      // Add error log
      addLogMessage(`Error: ${error.message}`, 'error');

      io.emit('status_update', syncStatus);
      io.emit('sync_complete', { success: false, error: error.message });
    });

  } catch (error) {
    console.error('API error:', error);
    syncStatus.isRunning = false;

    // Add error log
    addLogMessage(`API Error: ${error.message}`, 'error');

    res.status(500).json({ error: error.message });
  }
});
app.post('/api/tracking', async (req, res) => {
  if (syncStatus.isRunning) {
    return res.status(409).json({ error: 'A sync or tracking update is already running' });
  }

  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    // Reset status
    syncStatus.isRunning = true;
    syncStatus.type = 'tracking';
    syncStatus.startTime = new Date().toISOString();

    // Reset progress properties
    syncStatus.progress = {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0
    };
    syncStatus.accounts = [];
    syncStatus.logs = []; // Clear logs

    // Add initial log
    addLogMessage(`Starting tracking update for account: ${accountId}`);

    console.log('Reset status for tracking:', JSON.stringify(syncStatus));

    // Send initial status
    io.emit('status_update', syncStatus);

    // Start tracking process (non-blocking)
    res.json({ message: 'Tracking update started', status: syncStatus });

    // Run the tracking update
    const accounts = await loadAccounts();
    const account = accounts.find(acc => acc.name === accountId);

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    // Execute update tracking
    updateTracking([account], (progress) => {
      // Log all progress updates for debugging
      console.log('Tracking progress callback received:',
        progress.phase || 'unknown',
        progress.logMessage || '');

      // Add log message if provided, with specified type if available
      if (progress.logMessage) {
        const logType = progress.logType || 'info';
        addLogMessage(progress.logMessage, logType);
      }

      // Skip UI update if this is log-only
      if (progress.logOnly) {
        io.emit('status_update', syncStatus);
        return;
      }

      // Update UI progress if we have valid data
      if (progress && progress.total) {
        const progressData = progress.total;

        // For tracking updates, count "already tracked" as successful for progress purposes
        const alreadyTracked = progressData.alreadyTracked || 0;
        const updated = progressData.updated || 0;
        const totalSuccess = updated + alreadyTracked;
        
        // IMPORTANT: Use account specific data for more accurate progress
        // Let's calculate the exact processed/total values from accounts if available
        let processedValue = progressData.processed || 0;
        let totalValue = progressData.total || 0;
        
        // If we have account-specific data, prefer that for progress
        if (progress.accounts && progress.accounts.length > 0) {
          // Get values from the current account
          const account = progress.accounts[0];
          processedValue = account.processed || 0;
          totalValue = account.total || 0;
          
          // Use account-specific progress values
        }

        // Set progress values - order matters for reactivity
        syncStatus.progress = {
          processed: processedValue,
          total: totalValue,
          successful: totalSuccess,
          failed: Array.isArray(progressData.errors) ? progressData.errors.length : 0
        };
        
        // Ensure total is never 0 when we have processed items
        // This prevents division by zero in the UI's percentage calculation
        if (syncStatus.progress.total <= 0 && syncStatus.progress.processed > 0) {
          syncStatus.progress.total = syncStatus.progress.processed;
        }
        
        // Ensure processed count is never greater than total (for proper percentage calculation)
        if (syncStatus.progress.processed > syncStatus.progress.total && syncStatus.progress.total > 0) {
          syncStatus.progress.processed = syncStatus.progress.total;
        }

        syncStatus.accounts = progress.accounts || [];

        // Add tracking-specific data to help with debugging
        syncStatus.trackingDetails = {
          updated: updated,
          alreadyTracked: alreadyTracked,
          phase: progress.phase
        };

        // Calculate progress percentage for logging
        const progressPercentage = Math.min(100, Math.max(0,
          progress.phase === 'complete' ?
            100 : // Always 100% for complete phase
            (progressData.total > 0 ? Math.round((progressData.processed / progressData.total) * 100) : 0)
        ));

        // Log for debugging
        console.log('Tracking progress update:', {
          processed: syncStatus.progress.processed,
          total: syncStatus.progress.total,
          percentage: progressPercentage,
          updated: updated,
          alreadyTracked: alreadyTracked
        });
        
        // Scale down extremely large numbers while preserving ratios
        if (syncStatus.progress.total > 10000) {
          const ratio = syncStatus.progress.processed / syncStatus.progress.total;
          syncStatus.progress.total = 100;
          syncStatus.progress.processed = Math.round(ratio * 100);
        }

        io.emit('status_update', syncStatus);
      }
    }).then(result => {
      // Log the result
      console.log('Tracking completed with result:', JSON.stringify(result));

      // Update final status
      syncStatus.isRunning = false;

      // Calculate total shipments that were properly processed (both updated and already tracked)
      const alreadyTracked = result.total.alreadyTracked || 0;
      const updated = result.total.updated || 0;
      const totalProcessed = result.total.processed || 0;

      // Use account-specific processed/total values if available
      let finalProcessed = 0;
      let finalTotal = 0;
      
      // If we have account data, use the account-specific values
      if (result.accounts && result.accounts.length > 0) {
        // Sum up all account values
        result.accounts.forEach(account => {
          finalProcessed += (account.processed || 0);
          finalTotal += (account.total || 0);
        });
      } else {
        // Fallback to total values
        finalProcessed = totalProcessed;
        finalTotal = totalProcessed; // For 100% completion
      }
      
      // Set final progress - ORDER MATTERS for Alpine.js reactivity
      syncStatus.progress = {
        processed: finalProcessed,
        total: finalTotal,
        successful: updated + alreadyTracked, // Count both as successful
        failed: Array.isArray(result.total.errors) ? result.total.errors.length : 0
      };

      syncStatus.accounts = result.accounts || [];

      // Add completion log with detailed breakdown - mark as success
      addLogMessage(`Tracking update completed. Updated ${updated} orders, ${alreadyTracked} already tracked, ${syncStatus.progress.failed} errors.`, 'success');

      console.log('Final tracking status update:', JSON.stringify(syncStatus.progress));
      io.emit('status_update', syncStatus);
      io.emit('sync_complete', { success: true, result });
    }).catch(error => {
      console.error('Tracking error:', error);
      // Update error status
      syncStatus.isRunning = false;

      // Add error log
      addLogMessage(`Error: ${error.message}`, 'error');

      io.emit('status_update', syncStatus);
      io.emit('sync_complete', { success: false, error: error.message });
    });

  } catch (error) {
    console.error('API error:', error);
    syncStatus.isRunning = false;

    // Add error log
    addLogMessage(`API Error: ${error.message}`, 'error');

    res.status(500).json({ error: error.message });
  }
});
// Add a log message to the status
function addLogMessage(message, type = 'info') {
  // Create log entry with timestamp
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    message,
    type
  };

  // Check for duplicate messages to avoid error spam
  // Only check recent logs that are within the last 5 seconds
  const recentTime = new Date(Date.now() - 5000).toISOString();
  const isDuplicate = syncStatus.logs.some(entry => 
    entry.message === message && 
    entry.type === type &&
    entry.timestamp > recentTime
  );

  // Skip if it's a duplicate message
  if (isDuplicate) {
    console.log(`Skipping duplicate log: [${type}] ${message}`);
    return;
  }

  // Add to the beginning so newest are first
  syncStatus.logs.unshift(logEntry);

  // Limit the number of logs
  if (syncStatus.logs.length > MAX_LOGS) {
    syncStatus.logs = syncStatus.logs.slice(0, MAX_LOGS);
  }

  console.log(`Log: [${type}] ${message}`);
}

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current status to new client
  console.log('Sending status to new client:', JSON.stringify(syncStatus));
  socket.emit('status_update', syncStatus);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});