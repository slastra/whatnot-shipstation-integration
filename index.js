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
      console.log(`Progress callback received from sync-orders (phase: ${progress.phase || 'unknown'}):`, 
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
      
      // Update UI progress for phases that should show progress (primarily creation)
      if (progress && progress.total) {
        const progressData = progress.total;
        
        // Map the properties appropriately for the UI
        syncStatus.progress = {
          total: progressData.total || 0,
          processed: progress.phase === 'complete' ? progressData.total || 0 : progressData.processed || 0, // Set to 100% for complete phase
          successful: progressData.created || 0,
          failed: (progressData.errors && progressData.errors.length ? progressData.errors.length : 0) + 
                  (progressData.invalid || 0)
        };
        
        syncStatus.accounts = progress.accounts || [];
        
        // Calculate progress percentage for logging
        const progressPercentage = progress.phase === 'complete' ? 
          100 : // Always 100% for complete phase
          Math.round((progressData.processed / progressData.total) * 100);
        
        // Add consolidation details to the log if available
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
          processed: result.total.processed || 0,
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
      console.log('Tracking progress callback received:', JSON.stringify(progress));
      
      // Check if we have log message
      if (progress.logMessage) {
        addLogMessage(progress.logMessage);
      }
      
      // Skip UI update if this is log-only
      if (progress.logOnly) {
        io.emit('status_update', syncStatus);
        return;
      }
      
      // Update UI progress if we have valid data
      if (progress && progress.total) {
        const progressData = progress.total;
        
        syncStatus.progress = {
          total: progressData.total || 0,
          processed: progressData.processed || 0,
          successful: progressData.updated || 0,
          failed: progressData.errors ? progressData.errors.length : 0
        };
        
        syncStatus.accounts = progress.accounts || [];
        
        console.log('Emitting tracking status update:', JSON.stringify(syncStatus.progress));
        io.emit('status_update', syncStatus);
      }
    }).then(result => {
      // Log the result
      console.log('Tracking completed with result:', JSON.stringify(result));
      
      // Update final status
      syncStatus.isRunning = false;
      
      // Set final progress
      if (result && result.total) {
        syncStatus.progress = {
          total: result.total.total || 0,
          processed: result.total.processed || 0,
          successful: result.total.updated || 0,
          failed: result.total.errors ? result.total.errors.length : 0
        };
        
        syncStatus.accounts = result.accounts || [];
      }
      
      // Add completion log
      addLogMessage(`Tracking update completed. Updated ${result.total.updated} orders successfully.`);
      
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
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  
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