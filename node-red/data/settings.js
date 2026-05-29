module.exports = {
    // Static files (dashboard assets: circuit SVG, CSS, JS)
    httpStatic: '/data/public',

    // Base URL for the Node-RED editor
    httpAdminRoot: '/admin',

    // Base URL for HTTP nodes
    httpNodeRoot: '/api',

    // Flow directory (relative to this folder)
    userDir: '/data',
    flowFile: 'flows.json',

    // Encrypted credentials (key must NOT be committed — use an environment variable)
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'f1-telemetry-dev-secret',

    // Editor enabled (disable in production)
    disableEditor: false,

    // Logging
    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false
        }
    },

    // Editor security (optional, enable in production)
    // adminAuth: {
    //     type: 'credentials',
    //     users: [{ username: 'admin', password: '<bcrypt-hash>', permissions: '*' }]
    // },

    editorTheme: {
        projects: {
            // Disabled: Git is used directly on the mounted folder
            enabled: false
        }
    },

    functionGlobalContext: {
        crypto: require('crypto')
    }
};
