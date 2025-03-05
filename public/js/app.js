// Whatnot ShipStation Integration App
function appData() {
  return {
    // State
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
    showAccountModal: false,
    isLoadingAccounts: false,
    accountError: false,
    socket: null,

    // Computed properties
    get canStartSync() {
      return this.selectedAccount && !this.isRunning && this.selectedAccount.enabled;
    },

    // Lifecycle hooks
    init() {
      this.initializeSocket();
      this.fetchAccounts();
      this.fetchStatus();
    },

    // Methods
    initializeSocket() {
      this.socket = io();

      this.socket.on('connect', () => {
        this.addLogEntry('info', 'Connected to server');
      });

      this.socket.on('disconnect', () => {
        this.addLogEntry('error', 'Disconnected from server');
      });

      this.socket.on('status_update', (status) => {
        console.log('CLIENT: Received status update:', status);
        this.updateStatusFromServer(status);

        // Process any logs from the server
        if (status.logs && status.logs.length > 0) {
          status.logs.forEach(logEntry => {
            if (!this.logEntryExists(logEntry)) {
              this.processServerLogEntry(logEntry);
            }
          });
        }

        console.log('CLIENT: Updated local state:', this.progress);
      });

      this.socket.on('log_message', (logData) => {
        this.processServerLogEntry(logData);
      });

      this.socket.on('sync_complete', (result) => {
        if (result.success) {
          this.addLogEntry('success', `${this.capitalizeFirstLetter(this.syncType)} completed successfully`);
        } else {
          this.addLogEntry('error', `${this.capitalizeFirstLetter(this.syncType)} failed: ${result.error}`);
        }

        this.isRunning = false;
      });
    },

    // Add these new methods to the appData object
    processServerLogEntry(logEntry) {
      // Determine the log type based on the message content or provided type
      let type = logEntry.type || 'info';

      // If the type is already specified, respect it
      if (logEntry.type) {
        type = logEntry.type;
      } 
      // Otherwise, try to infer from content
      else {
        const lowerMessage = logEntry.message.toLowerCase();
        
        // For error messages - only if they explicitly mention an error or failure
        if (lowerMessage.includes('error:') || 
            lowerMessage.includes('failed:') || 
            lowerMessage.includes('failed to')) {
          type = 'error';
        }
        // For success indicators - but not just any message that has "complete" in it
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

      this.addLogEntry(type, logEntry.message);
    },

    logEntryExists(logEntry) {
      // Check if this exact log entry already exists to avoid duplicates
      return this.logEntries.some(entry =>
        entry.message === logEntry.message &&
        (entry.timestamp === new Date(logEntry.timestamp).toLocaleTimeString() ||
          entry.serverTimestamp === logEntry.timestamp)
      );
    },

    addLogEntry(type, message) {
      const timestamp = new Date().toLocaleTimeString();
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
      
      // Normal category-based styling
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

      // Keep track of server timestamp if available
      const serverTimestamp = null;

      this.logEntries.push({
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
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      });
    },

    updateStatusFromServer(status) {
      this.isRunning = status.isRunning;

      if (status.isRunning) {
        this.syncType = status.type || 'sync';
        this.syncStartTime = new Date(status.startTime);

        // Update progress
        const progress = status.progress;
        this.progress = {
          total: progress.total || 0,
          processed: progress.processed || 0,
          successful: progress.successful || 0,
          failed: progress.failed || 0
        };

        // Add specific tracking info if available
        if (this.syncType === 'tracking' && status.trackingInfo) {
          this.trackingInfo = status.trackingInfo;
          // Add tracking-specific log entry
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

    // Helper method to avoid duplicate log entries
    addUniqueLogEntry(type, message) {
      // Only add if this message doesn't exist in recent entries
      const isDuplicate = this.logEntries
        .slice(-5) // Check only last 5 entries for performance
        .some(entry => entry.message === message);

      if (!isDuplicate) {
        this.addLogEntry(type, message);
      }
    },

    fetchAccounts() {
      this.isLoadingAccounts = true;
      this.accountError = false;

      fetch('/api/accounts')
        .then(response => {
          if (!response.ok) {
            throw new Error('Failed to fetch accounts');
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
            throw new Error('Failed to fetch status');
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



    selectAccount(account) {
      this.selectedAccount = account;
      // Also update currentAccount so it displays in the ready state
      this.currentAccount = account;
      this.addLogEntry('info', `Selected account: ${account.name}`);
      this.showAccountModal = false;
    },

    startSync(type) {
      if (!this.canStartSync) return;

      const endpoint = type === 'sync' ? '/api/sync' : '/api/tracking';
      const actionName = type === 'sync' ? 'order sync' : 'tracking update';

      this.isRunning = true;
      this.syncType = type;
      this.syncStartTime = new Date();
      this.progress = { total: 0, processed: 0, successful: 0, failed: 0 };
      
      // Ensure currentAccount is set properly when starting sync
      if (this.selectedAccount && !this.currentAccount) {
        this.currentAccount = this.selectedAccount;
      }

      this.addLogEntry('info', `Starting ${actionName} for account: ${this.selectedAccount.name}`);

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
            throw new Error(`Failed to start ${actionName}`);
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


    clearLog() {
      this.logEntries = [];
      this.addLogEntry('info', 'Log cleared');
    },

    calculateProgressPercentage() {
      if (this.progress.total <= 0) return 0;
      
      const percentage = Math.round((this.progress.processed / this.progress.total) * 100);
      
      // Ensure percentage is a valid number between 0-100
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

    // Modify the getAccountStatusText method to provide more tracking-specific details
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

    // Add a method to format the progress message based on the sync type
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