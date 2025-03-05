document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const accountModal = document.getElementById('account-modal');
  const openAccountModalBtn = document.getElementById('open-account-modal');
  const closeAccountModalBtn = document.getElementById('close-account-modal');
  const cancelAccountModalBtn = document.getElementById('cancel-account-modal');
  const selectedAccountDisplay = document.getElementById('selected-account-display');
  const selectedAccountLabel = document.getElementById('selected-account-label');
  const accountsList = document.getElementById('accounts-list');
  const quickSyncBtn = document.getElementById('quick-sync-btn');
  const quickTrackBtn = document.getElementById('quick-track-btn');
  const statusWaiting = document.querySelector('.status-waiting');
  const statusActive = document.querySelector('.status-active');
  const syncTypeTag = document.querySelector('.is-sync-type');
  const syncStatus = document.getElementById('sync-status');
  const syncTime = document.getElementById('sync-time');
  const overallProgress = document.getElementById('overall-progress');
  const processedCount = document.getElementById('processed-count');
  const totalCount = document.getElementById('total-count');
  const successCount = document.getElementById('success-count');
  const errorCount = document.getElementById('error-count');
  const currentAccount = document.getElementById('current-account');
  const accountStatus = document.getElementById('account-status');
  const logContainer = document.getElementById('log-container');
  const clearLogBtn = document.querySelector('.clear-log');
  const loadingAccounts = document.querySelector('.is-loading-accounts');
  const accountError = document.querySelector('.is-account-error');
  
  // State
  let selectedAccount = null;
  let isRunning = false;
  let accounts = [];
  
  // Socket.io connection
  const socket = io();
  
  // ===== Event Listeners =====
  
  // Modal controls
  openAccountModalBtn.addEventListener('click', openAccountModal);
  closeAccountModalBtn.addEventListener('click', closeAccountModal);
  cancelAccountModalBtn.addEventListener('click', closeAccountModal);
  
  // Action buttons
  quickSyncBtn.addEventListener('click', () => {
    if (selectedAccount && !isRunning && selectedAccount.enabled) {
      startSync('sync', selectedAccount);
    }
  });
  
  quickTrackBtn.addEventListener('click', () => {
    if (selectedAccount && !isRunning && selectedAccount.enabled) {
      startSync('tracking', selectedAccount);
    }
  });
  
  // Socket events
  socket.on('connect', () => {
    addLogEntry('info', 'Connected to server');
    fetchAccounts();
    fetchStatus();
  });
  
  socket.on('disconnect', () => {
    addLogEntry('error', 'Disconnected from server');
  });
  
  socket.on('status_update', (status) => {
    isRunning = status.isRunning;
    updateStatusDisplay(status);
    updateActionButtons();
  });
  
  socket.on('sync_complete', (result) => {
    if (result.success) {
      addLogEntry('success', `${capitalizeFirstLetter(syncTypeTag.textContent || 'Sync')} completed successfully`);
    } else {
      addLogEntry('error', `${capitalizeFirstLetter(syncTypeTag.textContent || 'Sync')} failed: ${result.error}`);
    }
    
    isRunning = false;
    updateActionButtons();
  });
  
  // Clear log button
  clearLogBtn.addEventListener('click', () => {
    logContainer.innerHTML = '';
    addLogEntry('info', 'Log cleared');
  });
  
  // ===== Functions =====
  
  /**
   * Open account selection modal
   */
  function openAccountModal() {
    accountModal.classList.remove('hidden');
    // Re-render accounts in case they've changed
    renderAccountsInModal(accounts);
  }
  
  /**
   * Close account selection modal
   */
  function closeAccountModal() {
    accountModal.classList.add('hidden');
  }
  
  /**
   * Fetch accounts from the server
   */
  function fetchAccounts() {
    loadingAccounts.classList.remove('hidden');
    accountError.classList.add('hidden');
    
    fetch('/api/accounts')
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to fetch accounts');
        }
        return response.json();
      })
      .then(data => {
        accounts = data.accounts;
        renderAccountsInModal(accounts);
        loadingAccounts.classList.add('hidden');
      })
      .catch(error => {
        console.error('Error fetching accounts:', error);
        loadingAccounts.classList.add('hidden');
        accountError.classList.remove('hidden');
        addLogEntry('error', `Failed to load accounts: ${error.message}`);
      });
  }
  
  /**
   * Fetch current status from the server
   */
  function fetchStatus() {
    fetch('/api/status')
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        return response.json();
      })
      .then(status => {
        isRunning = status.isRunning;
        updateStatusDisplay(status);
        updateActionButtons();
      })
      .catch(error => {
        console.error('Error fetching status:', error);
        addLogEntry('error', `Failed to load status: ${error.message}`);
      });
  }
  
  /**
   * Render accounts in the modal
   */
  function renderAccountsInModal(accounts) {
    // Clear existing accounts
    accountsList.innerHTML = '';
    
    if (accounts.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'bg-gray-700 p-4 rounded-lg text-center';
      emptyNotice.innerHTML = '<i class="fas fa-info-circle mr-2"></i> No accounts found';
      accountsList.appendChild(emptyNotice);
      return;
    }
    
    // Create account items
    accounts.forEach(account => {
      const accountItem = document.createElement('div');
      accountItem.className = `bg-gray-700 hover:bg-gray-600 rounded-lg p-4 cursor-pointer transition-colors flex items-center justify-between ${account.enabled ? '' : 'opacity-60'}`;
      accountItem.dataset.accountId = account.id;
      
      // Indicate if this account is selected
      if (selectedAccount && selectedAccount.id === account.id) {
        accountItem.classList.add('ring-2', 'ring-blue-500');
      }
      
      const statusIcon = account.enabled 
        ? '<span class="text-green-400"><i class="fas fa-check-circle"></i></span>' 
        : '<span class="text-gray-500"><i class="fas fa-ban"></i></span>';
      
      accountItem.innerHTML = `
        <div class="flex items-center">
          <div class="mr-3">${statusIcon}</div>
          <div>${account.name}</div>
        </div>
        <div class="text-gray-400">
          <i class="fas fa-chevron-right"></i>
        </div>
      `;
      
      // Add click event
      accountItem.addEventListener('click', () => {
        selectAccount(account);
        closeAccountModal();
      });
      
      accountsList.appendChild(accountItem);
    });
    
    addLogEntry('info', `Loaded ${accounts.length} accounts`);
  }
  
  /**
   * Select an account
   */
  function selectAccount(account) {
    selectedAccount = account;
    
    // Update UI
    selectedAccountLabel.textContent = account.name;
    selectedAccountDisplay.classList.remove('hidden');
    
    // Update quick action buttons
    updateActionButtons();
    
    addLogEntry('info', `Selected account: ${account.name}`);
  }
  
  /**
   * Update quick action buttons based on selected account and running status
   */
  function updateActionButtons() {
    if (!selectedAccount || !selectedAccount.enabled || isRunning) {
      quickSyncBtn.disabled = true;
      quickTrackBtn.disabled = true;
      quickSyncBtn.classList.add('opacity-50', 'cursor-not-allowed');
      quickTrackBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
      quickSyncBtn.disabled = false;
      quickTrackBtn.disabled = false;
      quickSyncBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      quickTrackBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
  
  /**
   * Start a sync or tracking update
   */
  function startSync(type, account) {
    if (!account || !account.enabled || isRunning) return;
    
    const endpoint = type === 'sync' ? '/api/sync' : '/api/tracking';
    const actionName = type === 'sync' ? 'order sync' : 'tracking update';
    
    // Disable all buttons during sync
    isRunning = true;
    updateActionButtons();
    
    addLogEntry('info', `Starting ${actionName} for account: ${account.name}`);
    
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accountId: account.id
      })
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to start ${actionName}`);
        }
        return response.json();
      })
      .then(data => {
        addLogEntry('success', `${capitalizeFirstLetter(actionName)} started successfully`);
      })
      .catch(error => {
        console.error(`Error starting ${actionName}:`, error);
        addLogEntry('error', `Failed to start ${actionName}: ${error.message}`);
        
        // Reset running state on error
        isRunning = false;
        updateActionButtons();
      });
  }
  
  /**
   * Update the status display
   */
  function updateStatusDisplay(status) {
    if (status.isRunning) {
      // Show active status
      statusWaiting.classList.add('hidden');
      statusActive.classList.remove('hidden');
      
      // Update sync type
      syncTypeTag.textContent = status.type || 'sync';
      if (status.type === 'sync') {
        syncTypeTag.classList.remove('bg-indigo-600');
        syncTypeTag.classList.add('bg-blue-600');
      } else {
        syncTypeTag.classList.remove('bg-blue-600');
        syncTypeTag.classList.add('bg-indigo-600');
      }
      
      // Update start time
      const startTime = new Date(status.startTime);
      const timeAgo = getTimeAgo(startTime);
      syncTime.textContent = `Started: ${timeAgo}`;
      
      // Update progress
      const progress = status.progress;
      const total = progress.total || 0;
      const processed = progress.processed || 0;
      const successful = progress.successful || 0;
      const failed = progress.failed || 0;
      
      // Calculate percentage (avoid division by zero)
      let percentage = 0;
      if (total > 0) {
        percentage = Math.round((processed / total) * 100);
      }
      
      overallProgress.style.width = `${percentage}%`;
      processedCount.textContent = processed;
      totalCount.textContent = total;
      successCount.textContent = successful;
      errorCount.textContent = failed;
      
      // Update account status if any
      if (status.accounts && status.accounts.length > 0) {
        const currentAccountInfo = status.accounts[status.accounts.length - 1];
        currentAccount.textContent = currentAccountInfo.name;
        accountStatus.textContent = getAccountStatusText(currentAccountInfo);
      } else {
        currentAccount.textContent = 'None';
        accountStatus.textContent = 'Pending';
      }
      
    } else {
      // Show waiting status
      statusWaiting.classList.remove('hidden');
      statusActive.classList.add('hidden');
    }
  }
  
  /**
   * Add a log entry
   */
  function addLogEntry(type, message) {
    const logEntry = document.createElement('div');
    logEntry.className = `mb-1`;
    
    const timestamp = new Date().toLocaleTimeString();
    let textColorClass = '';
    
    switch(type) {
      case 'info':
        textColorClass = 'text-blue-400';
        break;
      case 'success':
        textColorClass = 'text-green-400';
        break;
      case 'error':
        textColorClass = 'text-red-400';
        break;
      case 'warning':
        textColorClass = 'text-yellow-400';
        break;
    }
    
    logEntry.innerHTML = `<span class="text-gray-500">[${timestamp}]</span> <span class="${textColorClass}">${message}</span>`;
    
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  
  /**
   * Get time ago string
   */
  function getTimeAgo(date) {
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
  }
  
  /**
   * Get account status text based on account results
   */
  function getAccountStatusText(account) {
    if (!account) return 'Pending';
    
    if (account.errors && account.errors.length > 0) {
      return `Error (${account.errors.length} errors)`;
    }
    
    if (account.processed === 0) {
      return 'No items to process';
    }
    
    if (account.created || account.updated) {
      const count = account.created || account.updated;
      const total = account.processed;
      return `Completed (${count}/${total})`;
    }
    
    return 'Processing';
  }
  
  /**
   * Capitalize first letter of a string
   */
  function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
  }
});