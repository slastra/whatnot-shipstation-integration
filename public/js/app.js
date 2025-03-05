// Whatnot ShipStation Integration App
function appData() {
  return {
    // Application State
    accounts: [],
    selectedAccount: null,
    currentAccount: null,
    isRunning: false,
    syncType: 'sync',
    syncStartTime: null,
    progress: {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0
    },
    logEntries: [],
    logCounter: 0,
    
    // UI State
    showAccountModal: false,
    isLoadingAccounts: false,
    accountError: false,
    
    // Socket connection
    socket: null,
    
    // Computed properties
    get canStartSync() {
      return this.selectedAccount && !this.isRunning && this.selectedAccount.enabled;
    },

    // Lifecycle methods
    init() {
      this.initializeSocket();
      this.fetchAccounts();
      this.fetchStatus();
    },

    // Socket Connection Methods
    initializeSocket() {
      this.socket = io();

      // Connection events
      this.socket.on('connect', () => {
        this.addLogEntry('info', 'Connected to server');
      });

      this.socket.on('disconnect', () => {
        this.addLogEntry('error', 'Disconnected from server');
      });

      // Status updates
      this.socket.on('status_update', (status) => {
        console.log('CLIENT: Received status update:', status);
        this.updateStatusFromServer(status);

        // Process logs in chronological order
        if (status.logs && status.logs.length > 0) {
          const sortedLogs = [...status.logs].sort((a, b) => {
            if (a.timestamp && b.timestamp) {
              return new Date(a.timestamp) - new Date(b.timestamp);
            }
            return 0;
          });
          
          sortedLogs.forEach(logEntry => {
            if (!this.logEntryExists(logEntry)) {
              this.processServerLogEntry(logEntry);
            }
          });
        }
      });

      // Individual log messages
      this.socket.on('log_message', (logData) => {
        this.processServerLogEntry(logData);
      });

      // Sync completion
      this.socket.on('sync_complete', (result) => {
        if (result.success) {
          this.addLogEntry('success', `${this.capitalizeFirstLetter(this.syncType)} completed successfully`);
        } else {
          this.addLogEntry('error', `${this.capitalizeFirstLetter(this.syncType)} failed: ${result.error}`);
        }

        this.isRunning = false;
      });
    },

    // Server communication methods
    fetchAccounts() {
      this.isLoadingAccounts = true;
      this.accountError = false;

      fetch('/api/accounts')
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to fetch accounts: ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          this.accounts = data.accounts;
          this.isLoadingAccounts = false;
          this.addLogEntry('info', `Loaded ${this.accounts.length} accounts`);
        })
        .catch(error => {
          console.error('Error fetching accounts:', error);
          this.isLoadingAccounts = false;
          this.accountError = true;
          this.addLogEntry('error', `Failed to load accounts: ${error.message}`);
        });
    },

    fetchStatus() {
      fetch('/api/status')
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to fetch status: ${response.status}`);
          }
          return response.json();
        })
        .then(status => {
          this.updateStatusFromServer(status);
        })
        .catch(error => {
          console.error('Error fetching status:', error);
          this.addLogEntry('error', `Failed to load status: ${error.message}`);
        });
    },

    startSync(type) {
      if (!this.canStartSync) return;

      const endpoint = type === 'sync' ? '/api/sync' : '/api/tracking';
      const actionName = type === 'sync' ? 'order sync' : 'tracking update';

      // Update local state
      this.isRunning = true;
      this.syncType = type;
      this.syncStartTime = new Date();
      this.progress = { total: 0, processed: 0, successful: 0, failed: 0 };

      // Ensure currentAccount is set properly
      if (this.selectedAccount && !this.currentAccount) {
        this.currentAccount = this.selectedAccount;
      }

      this.addLogEntry('info', `Starting ${actionName} for account: ${this.selectedAccount.name}`);

      // Send request to server
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          accountId: this.selectedAccount.id
        })
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
          }
          return response.json();
        })
        .then(data => {
          this.addLogEntry('success', `${this.capitalizeFirstLetter(actionName)} started successfully`);
        })
        .catch(error => {
          console.error(`Error starting ${actionName}:`, error);
          this.addLogEntry('error', `Failed to start ${actionName}: ${error.message}`);
          
          // Reset running state on error
          this.isRunning = false;
        });
    },

    // Status handling methods
    updateStatusFromServer(status) {
      this.isRunning = status.isRunning;

      if (status.isRunning) {
        this.syncType = status.type || 'sync';
        this.syncStartTime = new Date(status.startTime);

        // Update progress
        const progress = status.progress || {};
        this.progress = {
          total: progress.total || 0,
          processed: progress.processed || 0,
          successful: progress.successful || 0,
          failed: progress.failed || 0
        };

        // Add specific tracking info if available
        if (this.syncType === 'tracking' && status.trackingInfo) {
          this.trackingInfo = status.trackingInfo;
          
          if (status.trackingInfo.lastUpdated) {
            this.addUniqueLogEntry('info', `Last tracking update at ${new Date(status.trackingInfo.lastUpdated).toLocaleTimeString()}`);
          }
        }

        // Update current account if any
        if (status.accounts && status.accounts.length > 0) {
          this.currentAccount = status.accounts[status.accounts.length - 1];
        }
      } else {
        // When not running, ensure currentAccount syncs with selectedAccount
        if (this.selectedAccount && (!this.currentAccount || this.currentAccount.id !== this.selectedAccount.id)) {
          this.currentAccount = this.selectedAccount;
        }
      }
    },

    // Log handling methods
    processServerLogEntry(logEntry) {
      // Determine the log type based on the message content or provided type
      let type = logEntry.type || 'info';

      // If the type is not specified, infer from content
      if (!logEntry.type) {
        const lowerMessage = logEntry.message.toLowerCase();

        // For error messages
        if (lowerMessage.includes('error:') ||
            lowerMessage.includes('failed:') ||
            lowerMessage.includes('failed to')) {
          type = 'error';
        }
        // For success indicators
        else if (lowerMessage.startsWith('success') ||
                lowerMessage.includes('successfully') ||
                lowerMessage.includes('completed successfully')) {
          type = 'success';
        }
        // For tracking/normal completion messages
        else if (lowerMessage.includes('tracking update completed') ||
                lowerMessage.includes('completed tracking updates') ||
                lowerMessage.startsWith('completed processing')) {
          type = 'success';
        }
        // For warnings
        else if (lowerMessage.includes('warning')) {
          type = 'warning';
        }
      }

      // Use the server timestamp if available
      let timestamp;
      let serverTimestamp = null;
      
      if (logEntry.timestamp) {
        serverTimestamp = logEntry.timestamp;
        
        try {
          timestamp = new Date(logEntry.timestamp).toLocaleTimeString();
        } catch (e) {
          timestamp = new Date().toLocaleTimeString();
        }
      } else {
        timestamp = new Date().toLocaleTimeString();
      }

      // Add the entry with processed information
      this.addLogEntry(type, logEntry.message, timestamp, serverTimestamp);
    },

    logEntryExists(logEntry) {
      // Check if this exact log entry already exists to avoid duplicates
      return this.logEntries.some(entry => {
        // Check message content
        const messageMatch = entry.message === logEntry.message;
        
        // Check if timestamps match
        let timestampMatch = false;
        
        if (logEntry.timestamp) {
          // Check server timestamp
          if (entry.serverTimestamp === logEntry.timestamp) {
            timestampMatch = true;
          }
          
          // Also check formatted display timestamp
          try {
            const formattedTimestamp = new Date(logEntry.timestamp).toLocaleTimeString();
            if (entry.timestamp === formattedTimestamp) {
              timestampMatch = true;
            }
          } catch (e) {
            // Ignore timestamp parsing errors
          }
        }
        
        return messageMatch && timestampMatch;
      });
    },

    addLogEntry(type, message, customTimestamp = null, serverTimestamp = null) {
      const timestamp = customTimestamp || new Date().toLocaleTimeString();
      let textColorClass = '';

      // For consistent log styling, check message content in addition to type
      const lowerMessage = message.toLowerCase();

      // Override type based on message content for special cases
      if (type === 'info' &&
          (lowerMessage.includes('tracking update completed') ||
          lowerMessage.includes('completed tracking updates') ||
          lowerMessage.includes('completed successfully') ||
          lowerMessage.startsWith('completed processing'))) {
        type = 'success';
      }

      // Set text color class based on type
      switch (type) {
        case 'info':
          textColorClass = 'text-primary-400';
          break;
        case 'success':
          textColorClass = 'text-green-400';
          break;
        case 'error':
          textColorClass = 'text-red-400';
          break;
        case 'warning':
          textColorClass = 'text-amber-400';
          break;
      }

      // Generate a unique ID for this log entry
      const id = ++this.logCounter;

      // Add entry to log
      this.logEntries.push({
        id,
        timestamp,
        serverTimestamp,
        type,
        message,
        textColorClass
      });

      // Limit log entries to prevent memory issues (keep last 1000)
      if (this.logEntries.length > 1000) {
        this.logEntries = this.logEntries.slice(-1000);
      }

      // Scroll to bottom (in the next tick after DOM update)
      this.$nextTick(() => {
        const logContainer = document.getElementById('log-container');
        if (logContainer) {
          // Check if user was already at the bottom
          const wasAtBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 10;
          
          // Only auto-scroll if user was already at bottom
          if (wasAtBottom) {
            logContainer.scrollTop = logContainer.scrollHeight;
          }
        }
      });
    },

    // Helper to avoid duplicate log entries
    addUniqueLogEntry(type, message) {
      // Only add if this message doesn't exist in recent entries
      const isDuplicate = this.logEntries
        .slice(-5) // Check only last 5 entries for performance
        .some(entry => entry.message === message);

      if (!isDuplicate) {
        this.addLogEntry(type, message);
      }
    },

    // UI interaction methods
    selectAccount(account) {
      this.selectedAccount = account;
      // Also update currentAccount so it displays in the ready state
      this.currentAccount = account;
      this.addLogEntry('info', `Selected account: ${account.name}`);
      this.showAccountModal = false;
    },

    clearLog() {
      this.logEntries = [];
      this.addLogEntry('info', 'Log cleared');
    },

    // Utility methods
    calculateProgressPercentage() {
      if (this.progress.total <= 0) return 0;

      const percentage = Math.round((this.progress.processed / this.progress.total) * 100);

      // Ensure percentage is between 0-100
      return Math.max(0, Math.min(100, percentage || 0));
    },

    getTimeAgo(date) {
      if (!date) return 'Just now';

      const seconds = Math.floor((new Date() - date) / 1000);

      if (seconds < 60) {
        return `${seconds} sec ago`;
      }

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return `${minutes} min ago`;
      }

      const hours = Math.floor(minutes / 60);
      return `${hours} hr ago`;
    },

    getAccountStatusText(account) {
      if (!account) return 'Pending';

      if (account.errors && account.errors.length > 0) {
        return `Error (${account.errors.length} errors)`;
      }

      if (account.processed === 0) {
        return 'No items to process';
      }

      if (this.syncType === 'tracking' && account.updated !== undefined) {
        const updated = account.updated;
        const total = account.processed;
        return `Updated ${updated}/${total} orders`;
      } else if (account.created || account.updated) {
        const count = account.created || account.updated;
        const total = account.processed;
        return `Completed (${count}/${total})`;
      }

      return 'Processing';
    },

    getProgressMessage() {
      if (!this.isRunning) return '';

      const percentage = this.calculateProgressPercentage();

      if (this.syncType === 'tracking') {
        return `Updated ${this.progress.successful} tracking codes (${percentage}% complete)`;
      } else {
        return `Created ${this.progress.successful} orders (${percentage}% complete)`;
      }
    },

    capitalizeFirstLetter(string) {
      if (!string) return '';
      return string.charAt(0).toUpperCase() + string.slice(1);
    }
  };
}