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
    },

    // --- NEW: Counts Dialog State and Methods ---
    isCountsDialogOpen: false,
    countsData: null, // { totals: {}, timeSeries: {}, bucketType: '' }
    countsLoading: false,
    countsError: null,
    selectedCountsRange: 'today', // 'today', 'yesterday', 'thisWeek', 'last7days', 'thisMonth'
    selectedCountsTitle: 'Item Counts for Today', // Dynamic title

    // Helper to format Date object to YYYY-MM-DD
    formatDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    },

    // Calculates start and end dates based on the selected period
    getDateRange(period) {
      const today = new Date();
      let startDate = new Date(today); // Initialize with today
      let endDate = new Date(today);
      let title = 'Item Counts';

      switch (period) {
        case 'today':
          // Dates already set to today
          title = 'Item Counts for Today';
          break;
        case 'yesterday':
          startDate.setDate(today.getDate() - 1);
          endDate.setDate(today.getDate() - 1);
          title = 'Item Counts for Yesterday';
          break;
        case 'thisWeek': // Assuming Sunday is the start of the week
          startDate.setDate(today.getDate() - today.getDay());
          // endDate remains today
          title = 'Item Counts for This Week (Sun-Today)';
          break;
        case 'last7days':
          startDate.setDate(today.getDate() - 6);
          // endDate remains today
          title = 'Item Counts for Last 7 Days';
          break;
        case 'thisMonth':
          startDate = new Date(today.getFullYear(), today.getMonth(), 1);
          // endDate remains today
          title = 'Item Counts for This Month';
          break;
        default:
          console.warn('Invalid date range selected, defaulting to today');
          title = 'Item Counts for Today';
          period = 'today'; // Reset period
      }

      return {
        startDate: this.formatDate(startDate),
        endDate: this.formatDate(endDate),
        title: title,
        period: period // Return the potentially corrected period
      };
    },

    async openCountsDialog(range = null) { // Accept optional range override
      // Use provided range or current selection
      const targetRange = range || this.selectedCountsRange;
      
      // Update selection state if called directly (not via changeCountsRange)
      if (!range) {
        this.isCountsDialogOpen = true;
      }

      // If the dialog is not open yet, make sure it opens
      if (!this.isCountsDialogOpen) {
        this.isCountsDialogOpen = true;
      }

      this.countsLoading = true;
      this.countsError = null;
      this.countsData = null; // Clear previous data
      
      const { startDate, endDate, title, period } = this.getDateRange(targetRange);
      this.selectedCountsRange = period; // Update state with potentially corrected period
      this.selectedCountsTitle = title; // Update title

      console.log(`Fetching counts for ${period}: ${startDate} to ${endDate}`);

      try {
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
        console.log("Using timezone for API request:", userTimezone);
        const apiUrl = `/api/line-item-counts?startDate=${startDate}&endDate=${endDate}&timezone=${encodeURIComponent(userTimezone)}`;
        const response = await fetch(apiUrl);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! Status: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        this.countsData = data; // Update Alpine data

        // Wait for Alpine to update the DOM based on countsData/countsLoading changes
        this.$nextTick(() => {
          this.renderCombinedChart('combinedChart', data, userTimezone);
        });

        console.log("Counts data received:", data);
      } catch (error) {
        console.error(`Error fetching item counts for ${period}:`, error);
        this.countsError = error.message || 'Failed to load data.';
      } finally {
        this.countsLoading = false;
      }
    },

    // Method called by range selection buttons
    changeCountsRange(newRange) {
      if (this.countsLoading) return; // Don't change range while loading
      if (newRange === this.selectedCountsRange) return; // Don't refetch if range is the same
      
      console.log("Changing counts range to:", newRange);
      this.selectedCountsRange = newRange;
      this.openCountsDialog(newRange); // Fetch data for the new range
    },
  
    // Combined Chart rendering function
    renderCombinedChart(canvasId, data, userTimezone) {
      if (typeof Chart === 'undefined') {
        console.error("Chart.js is not loaded!");
        return;
      }
      const chartContainer = document.getElementById(`${canvasId}Container`); // Get container
      if (!chartContainer) {
        console.error(`Chart container element with ID '${canvasId}Container' not found.`);
        return;
      }
      if (!data || !data.timeSeries || !data.totals || Object.keys(data.totals).length === 0) {
        console.warn('No data available to render combined chart.');
        chartContainer.innerHTML = '<p class="text-center text-gray-500">No data available for the selected period.</p>'; // Show message
        return;
      }

      // Clear previous chart/message and create new canvas
      chartContainer.innerHTML = ''; 
      const canvasElement = document.createElement('canvas');
      canvasElement.id = canvasId;
      chartContainer.appendChild(canvasElement);

      const { timeSeries, totals, bucketType } = data;

      console.log("Raw totals received:", JSON.stringify(totals, null, 2));
      console.log("Raw timeSeries received:", JSON.stringify(timeSeries, null, 2));

      // Define a color palette
      const colors = [
        'rgba(168, 85, 247, 0.7)', // accent-500
        'rgba(163, 230, 53, 0.7)',  // primary-400
        'rgba(59, 130, 246, 0.7)', // blue-500 
        'rgba(234, 179, 8, 0.7)',  // yellow-500
        'rgba(249, 115, 22, 0.7)',  // orange-500
        'rgba(236, 72, 153, 0.7)', // pink-500
        'rgba(16, 185, 129, 0.7)', // emerald-500
        'rgba(99, 102, 241, 0.7)', // indigo-500
        'rgba(244, 63, 94, 0.7)',  // rose-500
        'rgba(14, 165, 233, 0.7)', // sky-500
      ];

      const ctx = canvasElement.getContext('2d');
      const chartTitle = bucketType === 'hourly' ? 'Items per Hour' : 'Items per Day';
      
      // 1. Aggregate all unique time labels (UTC hours or YYYY-MM-DD dates)
      let allLabelsSet = new Set();
      Object.values(timeSeries).forEach(userSeries => {
        Object.keys(userSeries || {}).forEach(label => allLabelsSet.add(label)); // Add null check for userSeries
      });
      const allSortedUTCLabels = [...allLabelsSet].sort(); // Sort chronologically

      const isHourly = bucketType === 'hourly';

      // 2. Create Map of Original Labels (UTC/Date) to Processed/Displayed Labels
      const labelMap = new Map();
      const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';

      allSortedUTCLabels.forEach(originalLabel => {
        try {
          let displayLabel = originalLabel; // Default fallback
          if (isHourly) {
            const utcDate = new Date(originalLabel);
            if (isNaN(utcDate)) {
               console.warn(`Invalid date encountered: ${originalLabel}, skipping.`);
               return; // Skips this iteration using return in forEach callback
            }

            // Get hour in target timezone (0-23) using Intl.DateTimeFormat for robustness
            let localizedHour;
            try {
              localizedHour = parseInt(new Intl.DateTimeFormat('en-US', { // en-US locale generally stable for hour extraction
                hour: 'numeric',
                hour12: false, // 24-hour format
                timeZone: displayTimezone
              }).format(utcDate), 10);
              if (isNaN(localizedHour)) throw new Error('Parsed hour is NaN');
            } catch (e) {
               console.error(`Error getting localized hour for ${originalLabel} in ${displayTimezone}:`, e);
               return; // Skip this label if timezone conversion fails
            }

            // --- FILTERING LOGIC ---
            // Only include hours between 5 AM (inclusive) and 8 PM (exclusive = 20)
            if (localizedHour >= 5 && localizedHour < 20) {
              // Format the display label for the chart (e.g., '6 PM CDT')
              displayLabel = utcDate.toLocaleTimeString('en-US', {
                hour: 'numeric',
                hour12: true,
              });
              labelMap.set(originalLabel, displayLabel); // Add to map only if within range
            } else {
              // Hour is outside 5 AM - 8 PM range, do nothing, effectively filtering it out
              // console.log(`Filtering out label ${originalLabel} (Hour: ${localizedHour} in ${displayTimezone})`); // Optional debug log
            }
            // --- END FILTERING LOGIC ---

          } else { // Daily buckets
             const parts = originalLabel.split('-');
             if (parts.length !== 3) {
                 console.warn(`Invalid daily date format: ${originalLabel}, skipping.`);
                 return; // Skip
             }
             // Use Date.UTC for consistent date parsing regardless of server timezone
             const dailyUtcDate = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
             if (isNaN(dailyUtcDate)) {
                 console.warn(`Invalid daily date generated: ${originalLabel}, skipping.`);
                 return; // Skip
             }
             // Display daily buckets just as MM/dd using UTC to avoid DST shifts affecting the date itself
             displayLabel = dailyUtcDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', timeZone: 'UTC' });
             labelMap.set(originalLabel, displayLabel); // Set label for daily buckets
          }

        } catch (e) {
          console.error(`Error processing label: ${originalLabel}`, e);
          // Don't set in map if there was an error during processing
        }
      }); // End of allSortedUTCLabels.forEach

      // 3. Get the unique final display labels, sorted correctly
      const uniqueFinalLabels = [...new Set(labelMap.values())].sort((a, b) => {
        // Find the *first* original UTC/date label that corresponds to each display label for sorting
        const findOriginal = (displayLabel) => [...labelMap.entries()].find(([key, val]) => val === displayLabel)?.[0];
        const originalA = findOriginal(a);
        const originalB = findOriginal(b);
        
        // If original labels can't be found (shouldn't happen), fallback to string compare
        if (!originalA || !originalB) return a.localeCompare(b);

        try {
          const dateA = new Date(originalA);
          const dateB = new Date(originalB);

          // Crucial: Compare based on the *hour* in the target timezone, not just the UTC timestamp
          const hourA = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: displayTimezone }).format(dateA), 10);
          const hourB = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: displayTimezone }).format(dateB), 10);

          if (isNaN(hourA) || isNaN(hourB)) {
              console.warn(`Could not parse hours for sorting: ${originalA} (${hourA}) or ${originalB} (${hourB})`);
              return dateA - dateB; // Fallback to UTC comparison
          }

          return hourA - hourB; // Sort by localized hour (5 AM < 6 AM < ... < 7 PM)

         } catch (e) {
            console.error(`Error during label sort comparison for ${a} (${originalA}) and ${b} (${originalB}):`, e);
            return a.localeCompare(b); // Fallback sort on display labels
         }
      });

      console.log("Final Unique Display Labels (Sorted):", uniqueFinalLabels);

      // 4. Create datasets for each user, aggregating data based on the final display labels
      const datasets = Object.keys(totals)
        .filter(userName => totals[userName] > 0) // Only include users with total items > 0
        .sort() // Sort user names alphabetically
        .map((userName, index) => {
          const userTimeSeries = timeSeries[userName] || {};
          // Aggregate data for each unique final label
          const userData = uniqueFinalLabels.map(displayLabel => {
            // Find all original labels that map to this display label
            const originalLabels = [...labelMap.entries()]
                                     .filter(([key, val]) => val === displayLabel)
                                     .map(([key]) => key);
            // Sum the values for those original labels
            return originalLabels.reduce((sum, originalKey) => sum + (userTimeSeries[originalKey] || 0), 0);
          });

          const colorIndex = index % colors.length;
          const color = colors[colorIndex];
          const borderColor = color.replace(', 0.7)', ', 1)'); // Make border opaque

          return {
            label: userName,
            data: userData,
            backgroundColor: color,
            borderColor: borderColor,
            borderWidth: 1,
            // Optional: make bars thinner if many users/buckets
            barThickness: Math.max(5, 20 - Object.keys(totals).length * 1.5), 
          };
        });

      // Destroy previous chart instance if necessary
      if (window.myCombinedChart && typeof window.myCombinedChart.destroy === 'function') {
        window.myCombinedChart.destroy();
      }
      
      // Render the new chart
      const chartContext = canvasElement.getContext('2d'); // Use a different variable name
      if (!chartContext) {
        console.error("Failed to get canvas context for rendering.");
        return;
      }
      window.myCombinedChart = 
        new Chart(chartContext, {
          type: 'bar', // Could also be 'line' if preferred
          data: {
            labels: uniqueFinalLabels, 
            datasets: datasets
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index', // Show tooltips for all datasets on hover
              intersect: false,
            },
            plugins: {
              title: {
                display: true,
                text: chartTitle,
                color: '#e4e4e7' // surface-200
              },
              legend: {
                display: true, // Show the legend
                position: 'bottom',
                labels: {
                  color: '#a1a1aa', // surface-400
                  boxWidth: 12, // Smaller color boxes
                  padding: 15
                }
              },
              tooltip: {
                backgroundColor: '#18181b', // surface-900
                titleColor: '#e4e4e7', // surface-200
                bodyColor: '#d4d4d8', // surface-300
                boxPadding: 3
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                stacked: false, // Set to true if you want stacked bars
                title: {
                  display: true,
                  text: 'Number of Items',
                  color: '#a1a1aa' // surface-400
                },
                ticks: {
                  color: '#a1a1aa', // surface-400
                  precision: 0 // Ensure whole numbers on axis
                },
                grid: {
                  color: 'rgba(113, 113, 122, 0.2)' // surface-600 with opacity
                }
              },
              x: {
                stacked: false, // Set to true if you want stacked bars
                title: {
                  display: true,
                  text: bucketType === 'hourly' ? 'Time' : 'Date',
                  color: '#a1a1aa' // surface-400
                },
                ticks: {
                  color: '#a1a1aa' // surface-400
                },
                grid: {
                  display: false // Hide vertical grid lines for cleaner look
                }
              }
            }
          }
        });
    }
  };
}