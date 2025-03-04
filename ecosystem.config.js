module.exports = {
  apps: [{
    name: 'whatnot-shipstation-sync',
    script: 'scripts/sync-orders.js',
    cron_restart: '0 4 * * *',
    autorestart: false
  }, {
    name: 'whatnot-shipstation-tracking',
    script: 'scripts/update-tracking.js',
    cron_restart: '0 4 * * *',
    autorestart: false
  }]
};
