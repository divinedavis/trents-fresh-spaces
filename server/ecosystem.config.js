module.exports = {
  apps: [
    {
      name: 'trents-fresh-spaces',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' },
    },
  ],
};
