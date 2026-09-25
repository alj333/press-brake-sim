const path = require('node:path');

const projectRoot = __dirname;

module.exports = {
  apps: [
    {
      name: 'press-brake-sim',
      cwd: projectRoot,
      script: 'server/index.ts',
      interpreter: 'node',
      node_args: '--import tsx',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '8090',
        DATA_DIR: path.resolve(projectRoot, '../../data/press-brake-sim'),
        DIST_DIR: path.resolve(projectRoot, 'dist'),
        TZ: 'Asia/Bangkok',
      },
      autorestart: true,
      restart_delay: 2000,
      max_memory_restart: '1G',
      time: true,
    },
  ],
};
